import { writeFileSync } from "node:fs";
import path from "node:path";

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const home = process.env.HOME;
writeFileSync(path.join(home, "quota-cwd.txt"), process.cwd());
const trust = process.env.QUOTA_FIXTURE_TRUST === "1" || process.cwd() !== home;
process.stdout.write(
  trust
    ? "Do you trust the contents of this project?\n> Yes, I trust this folder\n"
    : "? for shortcuts\n",
);
let input = "";
process.stdin.on("data", (data) => {
  input += data.toString();
  writeFileSync(path.join(home, "quota-input.txt"), input);
  if (!trust && input.includes("/usage\r")) {
    if (process.env.QUOTA_FIXTURE_UNKNOWN === "1") {
      process.stdout.write(
        "CLAUDE AND GPT MODELS\nChanged quota format 80% 70%\n",
      );
      return;
    }
    process.stdout.write(
      "(Google AI Test)\nGEMINI MODELS\nWeekly Limit\nRemaining: 60%\nFive Hour Limit\nRemaining: 80%\nCLAUDE AND GPT MODELS\nWeekly Limit\nRemaining: 20%\nFive Hour Limit\nRemaining: 40%\nQuota available\n",
    );
  }
});
process.stdin.on("end", () => process.exit(0));
