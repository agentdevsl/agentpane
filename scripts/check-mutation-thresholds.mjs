import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const THRESHOLDS_PATH = join(ROOT, "mutation-thresholds.json");
const REPORTS_DIR = join(ROOT, "reports", "mutation");

/**
 * Report file name convention: reports/mutation/<area>.json
 */
function reportPath(area) {
  return join(REPORTS_DIR, `${area}.json`);
}

/**
 * Parse a Stryker v9 JSON report and compute the mutation score.
 *
 * Score = killed / (killed + survived + timeout) * 100
 *
 * Statuses counted:
 *   - Killed     -> numerator + denominator
 *   - Survived   -> denominator only
 *   - Timeout    -> denominator only
 *   - NoCoverage -> excluded (not tested at all)
 */
function computeScore(reportFile) {
  const raw = readFileSync(reportFile, "utf-8");
  const report = JSON.parse(raw);

  let killed = 0;
  let survived = 0;
  let timeout = 0;

  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      switch (mutant.status) {
        case "Killed":
          killed++;
          break;
        case "Survived":
          survived++;
          break;
        case "Timeout":
          timeout++;
          break;
        // NoCoverage, CompileError, etc. are excluded from the score
      }
    }
  }

  const total = killed + survived + timeout;
  if (total === 0) {
    return { score: 100, killed, survived, timeout, total };
  }

  const score = (killed / total) * 100;
  return { score, killed, survived, timeout, total };
}

function main() {
  if (!existsSync(THRESHOLDS_PATH)) {
    console.error(`Thresholds file not found: ${THRESHOLDS_PATH}`);
    process.exit(1);
  }

  const thresholds = JSON.parse(readFileSync(THRESHOLDS_PATH, "utf-8"));
  const areas = Object.keys(thresholds);

  const results = [];
  const failures = [];

  for (const area of areas) {
    const file = reportPath(area);
    const config = thresholds[area];

    if (!existsSync(file)) {
      console.warn(`Warning: report not found for "${area}" at ${file} - skipping`);
      results.push({
        area,
        score: null,
        breakThreshold: config.break,
        warnThreshold: config.warn,
        status: "SKIP",
      });
      continue;
    }

    const { score, killed, survived, timeout, total } = computeScore(file);
    let status = "PASS";

    if (score < config.break) {
      status = "FAIL";
      failures.push({ area, score, breakThreshold: config.break });
    } else if (score < config.warn) {
      status = "WARN";
    }

    results.push({
      area,
      score,
      breakThreshold: config.break,
      warnThreshold: config.warn,
      status,
      killed,
      survived,
      timeout,
      total,
    });
  }

  // Print summary table
  console.log("");
  console.log("Mutation Score Thresholds");
  console.log("========================");
  console.log(
    pad("Area", 20) +
      pad("Score", 10) +
      pad("Break", 10) +
      pad("Warn", 10) +
      "Status"
  );

  for (const r of results) {
    const scoreStr = r.score !== null ? `${r.score.toFixed(1)}%` : "N/A";
    const breakStr = `${r.breakThreshold}%`;
    const warnStr = `${r.warnThreshold}%`;

    let statusStr;
    switch (r.status) {
      case "PASS":
        statusStr = "PASS";
        break;
      case "WARN":
        statusStr = `Below warn`;
        break;
      case "FAIL":
        statusStr = `FAIL`;
        break;
      case "SKIP":
        statusStr = "Skipped (no report)";
        break;
    }

    console.log(
      pad(r.area, 20) +
        pad(scoreStr, 10) +
        pad(breakStr, 10) +
        pad(warnStr, 10) +
        statusStr
    );
  }

  console.log("");

  // Print detailed mutant counts for areas that have data
  const withData = results.filter((r) => r.score !== null);
  if (withData.length > 0) {
    console.log("Details:");
    for (const r of withData) {
      console.log(
        `  ${r.area}: ${r.killed} killed, ${r.survived} survived, ${r.timeout} timeout (${r.total} total)`
      );
    }
    console.log("");
  }

  // Final result
  if (failures.length > 0) {
    const details = failures
      .map(
        (f) =>
          `${f.area} below break threshold: ${f.score.toFixed(1)}% < ${f.breakThreshold}%`
      )
      .join("; ");
    console.log(`Result: FAIL (${details})`);
    process.exit(1);
  }

  console.log("Result: PASS (all areas above break threshold)");
  process.exit(0);
}

function pad(str, width) {
  if (str.length >= width) return str + " ";
  return str + " ".repeat(width - str.length);
}

main();
