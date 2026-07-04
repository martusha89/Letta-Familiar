import { createInterface } from "node:readline";

// Interactive (TTY) runs get a fresh readline per question, which keeps the
// raw-mode password path conflict-free. Piped stdin gets ONE shared readline
// for the whole run: a per-question interface buffers all pending piped input
// and discards it on close, so every prompt after the first would hang on
// drained stdin and Node would exit 0 mid-deploy.
let sharedRL = null;
let pendingResolve = null;

function sharedQuestion(promptText) {
  return new Promise((resolve) => {
    if (!sharedRL) {
      sharedRL = createInterface({ input: process.stdin, output: process.stdout });
      // Piped stdin can end before every prompt is answered; treat EOF as a
      // blank answer instead of silently exiting mid-deploy.
      sharedRL.on("close", () => {
        sharedRL = null;
        if (pendingResolve) {
          const p = pendingResolve;
          pendingResolve = null;
          p("");
        }
      });
    }
    pendingResolve = resolve;
    sharedRL.question(promptText, (answer) => {
      pendingResolve = null;
      resolve(answer);
    });
  });
}

function question(promptText) {
  if (!process.stdin.isTTY) {
    return sharedQuestion(promptText);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Call once after the last prompt, or the shared readline keeps stdin open
// and the process never exits.
export function closePrompts() {
  if (sharedRL) {
    const rl = sharedRL;
    sharedRL = null;
    pendingResolve = null;
    rl.close();
  }
}

export async function ask(q, defaultValue) {
  const prompt = defaultValue ? `${q} [${defaultValue}]: ` : `${q}: `;
  const answer = await question(prompt);
  return answer.trim() || defaultValue || "";
}

export async function confirm(q) {
  const answer = await question(`${q} (y/N): `);
  return answer.trim().toLowerCase() === "y";
}

export async function password(q) {
  const stdin = process.stdin;

  if (!stdin.isTTY || !stdin.setRawMode) {
    const answer = await question(`${q}: `);
    return answer.trim();
  }

  process.stdout.write(`${q}: `);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve) => {
    let input = "";
    const onData = (buf) => {
      const ch = buf.toString("utf8");
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        resolve(input.trim());
      } else if (ch === "") {
        stdin.setRawMode(wasRaw || false);
        process.exit(1);
      } else if (ch === "" || ch === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch.charCodeAt(0) >= 32) {
        input += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export async function select(q, options) {
  console.log(`\n${q}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const answer = await question(`\nChoice [1]: `);
  const idx = parseInt(answer || "1", 10) - 1;
  return idx >= 0 && idx < options.length ? idx : 0;
}
