import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { benchmarkReportGuide } from "./benchmarkInspection.js";

export const benchmarkPostRunInstructions = (
  directory: string,
  outputDirectory = directory,
  platform = process.platform,
) => {
  const output = resolve(outputDirectory);
  const html = join(output, "report.html");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const open =
    platform === "win32"
      ? `Open in PowerShell: Start-Process -FilePath '${html.replaceAll("'", "''")}'`
      : `Open: ${platform === "darwin" ? "open" : "xdg-open"} ${quote(html)}`;
  return [
    `Report: ${html}`,
    open,
    `Browser URL: ${pathToFileURL(html).href}`,
    `Exports: ${join(output, "report.json")}, ${join(output, "evaluations.csv")}`,
    `Generated source and patches: ${join(resolve(directory), "candidates")} (use the report's exact candidate links)`,
    `Post-run inspection guide: ${benchmarkReportGuide}`,
    `Preserve frozen evidence at ${resolve(directory)}; judge scores and this inspection guide do not grant human or project acceptance.`,
  ];
};
