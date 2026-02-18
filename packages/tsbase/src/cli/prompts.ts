import { createInterface } from "node:readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export function closePrompts() {
  rl.close();
}

export async function text(
  message: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await ask(`  ${message}${suffix}: `);
  return answer || defaultValue || "";
}

export async function select<T extends string>(
  message: string,
  options: { label: string; value: T }[],
): Promise<T> {
  console.log(`\n  ${message}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${i + 1}) ${options[i].label}`);
  }
  console.log();

  while (true) {
    const answer = await ask("  Choose (number): ");
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      return options[num - 1].value;
    }
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

export async function multiSelect<T extends string>(
  message: string,
  options: { label: string; value: T }[],
): Promise<T[]> {
  console.log(`\n  ${message}\n`);
  for (let i = 0; i < options.length; i++) {
    console.log(`    ${i + 1}) ${options[i].label}`);
  }
  console.log(`    0) None`);
  console.log();

  while (true) {
    const answer = await ask("  Choose (comma-separated numbers, or 0): ");
    if (answer === "0" || answer === "") return [];

    const nums = answer.split(",").map((s) => parseInt(s.trim(), 10));
    if (nums.every((n) => n >= 1 && n <= options.length)) {
      return [...new Set(nums)].map((n) => options[n - 1].value);
    }
    console.log(
      `  Please enter numbers between 1 and ${options.length}, or 0 for none.`,
    );
  }
}

export async function confirm(
  message: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`  ${message} (${hint}): `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}
