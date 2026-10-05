import { Page } from "playwright";
import { Issue } from "./types.js";

export type ScreenshotDiffResult = {
  /** Number of pixels that differ between the two images. */
  diffPixels: number;
  /** Total number of pixels compared. */
  totalPixels: number;
  /** Percentage of pixels that differ (0–100). */
  diffPercentage: number;
};

/**
 * Compares two PNG screenshot buffers pixel-by-pixel using the browser's
 * canvas API. Returns the number of differing pixels and the percentage.
 * Both images must have the same dimensions — a size mismatch is reported
 * as the larger of the two image areas (100% diff).
 */
export async function diffScreenshots(page: Page, current: Buffer, baseline: Buffer): Promise<ScreenshotDiffResult> {
  const currentDataUrl = `data:image/png;base64,${current.toString("base64")}`;
  const baselineDataUrl = `data:image/png;base64,${baseline.toString("base64")}`;
  return page.evaluate(({ current, baseline }: { current: string; baseline: string }): Promise<ScreenshotDiffResult> => {
    const loadImage = (dataUrl: string): Promise<HTMLImageElement> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });
    };
    const run = async (): Promise<ScreenshotDiffResult> => {
      const img1 = await loadImage(current);
      const img2 = await loadImage(baseline);
      const width = Math.max(img1.width, img2.width);
      const height = Math.max(img1.height, img2.height);
      if (img1.width !== img2.width || img1.height !== img2.height) {
        return { diffPixels: width * height, totalPixels: width * height, diffPercentage: 100 };
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img1, 0, 0);
      const data1 = ctx.getImageData(0, 0, width, height);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img2, 0, 0);
      const data2 = ctx.getImageData(0, 0, width, height);
      const totalPixels = data1.data.length / 4;
      let diffPixels = 0;
      for (let i = 0; i < data1.data.length; i += 4) {
        const r = Math.abs(data1.data[i] - data2.data[i]);
        const g = Math.abs(data1.data[i + 1] - data2.data[i + 1]);
        const b = Math.abs(data1.data[i + 2] - data2.data[i + 2]);
        const a = Math.abs(data1.data[i + 3] - data2.data[i + 3]);
        if (r + g + b + a > 0) diffPixels++;
      }
      return { diffPixels, totalPixels, diffPercentage: (diffPixels / totalPixels) * 100 };
    };
    return run();
  }, { current: currentDataUrl, baseline: baselineDataUrl });
}

/** Builds a FAIL issue when the diff percentage exceeds the threshold. */
export function buildScreenshotDiffIssue(result: ScreenshotDiffResult, threshold: number): Issue | null {
  if (result.diffPercentage <= threshold) return null;
  return {
    status: "FAIL",
    code: "visual-regression",
    message: `Visual regression: ${result.diffPercentage.toFixed(2)}% of pixels differ from the baseline (${result.diffPixels}/${result.totalPixels} pixels), exceeding the ${threshold}% threshold.`,
    count: 1,
  };
}
