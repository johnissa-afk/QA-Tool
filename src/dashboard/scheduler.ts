import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QaAnalysis } from "../ai/types.js";
import {
  ScheduleStore,
  type ProjectSchedule,
  type ScheduledExecution,
  type ScheduleTrigger,
} from "./project-schedules.js";
import type { QaRun, RunManager } from "./run-manager.js";

/** How often due schedules are checked. A miss only delays a run; the claim
 *  itself is time-based, so correctness never depends on this interval. */
const DEFAULT_TICK_MS = 30_000;

export type ScheduleProject = {
  id: string;
  name: string;
  url: string;
};

/** The slice of ProjectStore the scheduler needs. Narrow on purpose: the
 *  scheduler must not be able to create, edit, or delete Projects. */
export type ScheduleProjectSource = {
  get(id: string): ScheduleProject | null;
};

export type SchedulerOptions = {
  schedules: ScheduleStore;
  runManager: RunManager;
  projects: ScheduleProjectSource;
  /** Test seam for the child spawner is on RunManager; this is the clock seam. */
  now?: () => number;
  tickMs?: number;
  /** Decides whether a real report artifact proves an interrupted run
   *  finished. Return false to leave the execution INTERRUPTED. */
  proveRunCompleted?: (execution: ScheduledExecution) => { completed: boolean; qaStatus?: string | null };
  onLog?: (message: string) => void;
  /**
   * Called after an execution has been PERSISTED in a state a person needs to
   * know about (skipped, cancelled, missing project) and after one is recorded
   * as failed or interrupted. This is the scheduler's only outward hook for
   * notifications: it fires once per recorded terminal outcome and never for an
   * ordinary successful run, so activity noise cannot become notifications.
   * `runId` is the run the scheduler recorded as in flight, when there was one.
   */
  onExecutionRecorded?: (execution: ScheduledExecution, runId: string | null) => void;
};

export type TickResult = {
  /** True when this tick found and handled at least one due slot. */
  dispatched: boolean;
  /** Every execution this tick created, whether it ran or was skipped. */
  executions: ScheduledExecution[];
  /** Slots that were due but could not be handled. */
  errors: string[];
};

/**
 * Dispatches due QA schedule slots through the existing run pipeline.
 *
 * The design rule throughout: the scheduler decides *when* a Project should be
 * tested and then does nothing else. It starts the same RunManager, which runs
 * the same CLI, which writes the same artifacts and reports the same results. A
 * scheduled run is only a run that happened without someone clicking the button.
 */
export class Scheduler {
  private readonly options: Required<Omit<SchedulerOptions, "proveRunCompleted" | "onExecutionRecorded">> &
    Pick<SchedulerOptions, "proveRunCompleted" | "onExecutionRecorded">;
  private timer: NodeJS.Timeout | null = null;
  /** Set while a tick is in flight so ticks can never overlap themselves. */
  private ticking = false;
  /** True only after stop() is called. Constructed usable so an embedder that
   *  wants to drive ticks itself never has to start a timer. */
  private stopped = false;

  constructor(options: SchedulerOptions) {
    this.options = {
      schedules: options.schedules,
      runManager: options.runManager,
      projects: options.projects,
      now: options.now ?? (() => Date.now()),
      tickMs: options.tickMs ?? DEFAULT_TICK_MS,
      onLog: options.onLog ?? (() => {}),
      proveRunCompleted: options.proveRunCompleted,
      onExecutionRecorded: options.onExecutionRecorded,
    };
  }

  /**
   * Reconciles work left in flight by a previous process, then begins ticking.
   *
   * Recovery runs before any slot can be dispatched, so an execution this
   * process knows nothing about can never be marked as its own success.
   *
   * Recovery is independent of the timer: a server started with the timer off
   * still reconciles its document, because leaving RUNNING rows unresolved
   * would be wrong regardless of who dispatches.
   */
  start(options: { timer?: boolean } = {}): { reconciled: ScheduledExecution[]; interrupted: ScheduledExecution[] } {
    this.stopped = false;
    const recovery = this.recover();
    if (options.timer !== false && this.timer === null) {
      this.timer = setInterval(() => {
        this.tick();
      }, this.options.tickMs);
      // A timer must never hold the process open on its own.
      this.timer.unref?.();
    }
    return recovery;
  }

  /**
   * Stops ticking and refuses further dispatch. In-flight QA runs are the
   * run manager's to manage, so they are left to settle and are reconciled by
   * recovery if this process ends first.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reconciles executions abandoned by a previous process. */
  recover(): { reconciled: ScheduledExecution[]; interrupted: ScheduledExecution[] } {
    const result = this.options.schedules.recover(
      execution => this.options.proveRunCompleted?.(execution) ?? { completed: false },
      this.options.now(),
    );
    for (const execution of result.interrupted) {
      this.options.onLog(`Scheduled run ${execution.executionId} was interrupted and is recorded as such.`);
      // An execution abandoned by a crash is a real failure of a real run, so
      // it is notified like any other recorded failure. Re-processing the same
      // execution on a later restart writes the same dedup key and therefore
      // adds nothing, so recovery cannot turn restarts into inbox noise. A
      // reconciled execution genuinely completed before the restart and stays
      // silent, exactly as an ordinary successful run does.
      this.options.onExecutionRecorded?.(execution, execution.runId);
    }
    for (const execution of result.reconciled) {
      this.options.onLog(`Scheduled run ${execution.executionId} completed before the restart.`);
    }
    return result;
  }

  /**
   * Handles every schedule that is due right now.
   *
   * The loop is synchronous and each slot is claimed before any async work
   * begins, so a slow, failing, or overlapping dispatch cannot make two ticks
   * run the same slot twice.
   */
  tick(): TickResult {
    const result: TickResult = { dispatched: false, executions: [], errors: [] };
    if (this.stopped || this.ticking) return result;
    this.ticking = true;
    try {
      const nowMs = this.options.now();
      for (const schedule of this.options.schedules.dueSchedules(nowMs)) {
        const handled = this.dispatch(schedule, nowMs);
        if (handled.ok) {
          result.executions.push(handled.value);
          result.dispatched = true;
        } else {
          // One bad schedule must never stop the others.
          result.errors.push(handled.error);
          this.options.onLog(`Scheduled dispatch failed: ${handled.error}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  /**
   * Runs one schedule immediately, ignoring whether its next slot is due.
   *
   * This is the safe manual path used to validate scheduling without waiting for
   * a real interval to elapse. It goes through exactly the same claim and
   * dispatch code as a due tick, so what it proves about behaviour is what a
   * timed run does.
   */
  triggerNow(projectId: string, trigger: ScheduleTrigger = "MANUAL_TRIGGER"): { ok: true; value: ScheduledExecution } | { ok: false; status: number; error: string } {
    if (this.stopped) return { ok: false, status: 503, error: "The scheduler is not running." };
    const schedule = this.options.schedules.get(projectId);
    if (!schedule) return { ok: false, status: 404, error: "This project has no QA schedule." };
    if (!schedule.enabled) return { ok: false, status: 409, error: "Enable this project's QA schedule first." };

    const nowMs = this.options.now();

    // Overlap is checked BEFORE the claim, exactly as a due tick does it, so a
    // manual trigger against a project that is already running is recorded as a
    // skip for the slot it would have consumed instead of being claimed and
    // then failed by the run manager's single-run rule.
    if (this.isBusy(schedule.projectId)) {
      const active = this.options.runManager.activeRun();
      const recorded = this.options.schedules.recordSkippedOverlap(
        schedule.projectId,
        schedule.nextRunAt ?? new Date(nowMs).toISOString(),
        active
          ? `Skipped because run ${active.runId} was already in progress.`
          : "Skipped because another scheduled run for this project was still being dispatched.",
        nowMs,
      );
      if (!recorded.ok) return recorded;
      this.options.onLog(`Skipped ${schedule.projectId}: a run was already in progress.`);
      // The skip is persisted, so this is the point a notification can honestly
      // exist. The run it describes is the one the scheduler just observed.
      this.options.onExecutionRecorded?.(recorded.value, active?.runId ?? null);
      return recorded;
    }

    // A manual trigger is still a slot, so the schedule advances exactly as it
    // would for a due tick and cannot be double-run by the timer.
    const claimed = this.options.schedules.claimDue(schedule.id, { nowMs, trigger });
    if (!claimed.ok) return claimed;
    const settled = this.dispatchClaimed(schedule, claimed.value, nowMs);
    if (settled.ok) return settled;
    return { ok: false, status: 500, error: settled.error };
  }

  /** Handles one due schedule. */
  private dispatch(
    schedule: ProjectSchedule,
    nowMs: number,
  ): { ok: true; value: ScheduledExecution } | { ok: false; status: number; error: string } {
    const scheduledFor = schedule.nextRunAt;
    if (scheduledFor === null) return { ok: false, status: 409, error: `Schedule ${schedule.id} has no next run time.` };

    const project = this.options.projects.get(schedule.projectId);
    if (!project) {
      // A Project that was deleted must not hold its slot open forever.
      const recorded = this.options.schedules.recordMissingProject(
        schedule.projectId,
        scheduledFor,
        "The project no longer exists, so no run was started.",
        nowMs,
      );
      if (!recorded.ok) return recorded;
      this.options.onLog(`Skipped ${schedule.projectId}: the project no longer exists.`);
      this.options.onExecutionRecorded?.(recorded.value, null);
      return recorded;
    }

    // Overlap is checked BEFORE the slot is claimed so a skip never burns the
    // real slot's execution record, and after the project check so a missing
    // project reports the reason it actually has.
    if (this.isBusy(project.id)) {
      const active = this.options.runManager.activeRun();
      const recorded = this.options.schedules.recordSkippedOverlap(
        project.id,
        scheduledFor,
        active
          ? `Skipped because run ${active.runId} was already in progress.`
          : "Skipped because another scheduled run for this project was still being dispatched.",
        nowMs,
      );
      if (!recorded.ok) return recorded;
      this.options.onLog(`Skipped ${project.id}: a run was already in progress.`);
      this.options.onExecutionRecorded?.(recorded.value, active?.runId ?? null);
      return recorded;
    }

    const claimed = this.options.schedules.claimDue(schedule.id, { nowMs });
    if (!claimed.ok) return claimed;
    return this.dispatchClaimed(schedule, claimed.value, nowMs);
  }

  /** Starts the real run for an already-claimed slot. */
  private dispatchClaimed(
    schedule: ProjectSchedule,
    execution: ScheduledExecution,
    nowMs: number,
  ): { ok: true; value: ScheduledExecution } | { ok: false; status: number; error: string } {
    const project = this.options.projects.get(schedule.projectId);
    if (!project) {
      // The Project vanished between the claim and the launch.
      const failed = this.options.schedules.markSettled(
        execution.executionId,
        { ok: false, runId: null, qaStatus: null, detail: "The project no longer existed when the run was about to start." },
        nowMs,
      );
      if (failed.ok) this.options.onExecutionRecorded?.(failed.value, null);
      return failed.ok ? { ok: true, value: failed.value } : failed;
    }

    this.options.schedules.markDispatching(project.id, true);
    try {
      const started = this.options.runManager.start(project.url, project.id, {
        scheduleId: schedule.id,
        scheduledExecutionId: execution.executionId,
      });
      if (!started.ok) {
        // A start failure is a real failure of this slot, not a skip: the engine
        // refused or the URL was rejected, and that belongs in history as FAILED.
        const failed = this.options.schedules.markSettled(
          execution.executionId,
          { ok: false, runId: null, qaStatus: null, detail: started.error },
          this.options.now(),
        );
        if (failed.ok) this.options.onExecutionRecorded?.(failed.value, null);
        return failed.ok ? { ok: true, value: failed.value } : failed;
      }
      const running = this.options.schedules.markRunning(execution.executionId, started.run.runId, this.options.now());
      if (!running.ok) return running;
      this.options.onLog(`Started scheduled run ${started.run.runId} for ${project.name}.`);
      return running;
    } finally {
      // The run now exists, so it is the run manager's single-run rule that
      // guards overlap from here on, not the scheduler's own flag.
      this.options.schedules.markDispatching(project.id, false);
    }
  }

  /** True when this project already has work in progress, from either source. */
  private isBusy(projectId: string): boolean {
    const active = this.options.runManager.activeRun();
    if (active && active.projectId === projectId) return true;
    return this.options.schedules.isDispatching(projectId);
  }

  /**
   * Records a scheduled run's real outcome. Called from the run manager's
   * settle hook, so the execution is only ever completed by the run that
   * actually produced the result.
   */
  onRunSettled(run: QaRun, analysis: QaAnalysis | null): void {
    const executionId = run.scheduledExecutionId;
    if (!executionId) return;
    const settled = this.options.schedules.markSettled(executionId, {
      ok: run.state === "COMPLETED" && analysis !== null,
      runId: run.runId,
      // Read from the real artifact when there is one, and from the run's own
      // recorded verdict otherwise. Never defaulted to a passing status.
      qaStatus: analysis?.summary?.overallStatus ?? run.qaStatus ?? null,
      detail:
        run.state === "COMPLETED" && analysis === null
          ? "The run finished but left no readable report artifact, so it was recorded as failed."
          : run.error,
    });
    // Only a slot that did NOT complete is news. A scheduled run that finished
    // its real QA run is ordinary activity and must not become a notification.
    if (settled.ok && settled.value.status !== "COMPLETED") {
      this.options.onExecutionRecorded?.(settled.value, run.runId);
    }
  }
}

/**
 * Builds the proof function recovery uses, from real artifacts on disk.
 *
 * Recovery runs in a process that has never seen the previous runs, so proof
 * cannot come from memory. An interrupted execution is only treated as completed
 * when the run artifact for its real run id exists AND parses as an analysis.
 * A missing file, an unparseable file, or an execution that never received a
 * run id all leave the execution INTERRUPTED, because none of them prove the
 * run finished.
 */
export function artifactProof(runsDir: string): (execution: ScheduledExecution) => { completed: boolean; qaStatus?: string | null } {
  return execution => {
    if (!execution.runId) return { completed: false };
    // The run id is sanitized on write, so it cannot escape the runs directory.
    const artifact = join(runsDir, execution.runId, "qa-analysis.json");
    try {
      if (!existsSync(artifact)) return { completed: false };
      const parsed = JSON.parse(readFileSync(artifact, "utf8")) as QaAnalysis;
      return { completed: true, qaStatus: parsed?.summary?.overallStatus ?? null };
    } catch {
      // An unreadable or truncated artifact proves nothing.
      return { completed: false };
    }
  };
}