const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;

const fmt = (code) => (text) => isColorSupported ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = fmt("1");
export const dim = fmt("2");
export const red = fmt("31");
export const green = fmt("32");
export const yellow = fmt("33");
export const blue = fmt("34");
export const magenta = fmt("35");
export const cyan = fmt("36");

export function banner() {
  console.log(cyan(bold("\n  FAMILIAR")));
  console.log(dim("  A chat client for your Letta agent\n"));
}

export function step(n, total, text) {
  console.log(cyan(`[${n}/${total}]`) + ` ${text}`);
}

export function success(text) {
  console.log(green("  ✓ ") + text);
}

export function warn(text) {
  console.log(yellow("  ! ") + text);
}

export function fail(text) {
  console.log(red("  ✗ ") + text);
}

export function info(text) {
  console.log(dim("  → ") + text);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(text) {
  if (!isColorSupported) {
    process.stdout.write(`  ${text}...`);
    return {
      stop: (final) => console.log(` ${final || "done"}`),
      fail: (final) => console.log(` ${final || "failed"}`),
    };
  }
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${text}`);
  }, 80);
  return {
    stop(final) {
      clearInterval(id);
      process.stdout.write(`\r  ${green("✓")} ${final || text}\n`);
    },
    fail(final) {
      clearInterval(id);
      process.stdout.write(`\r  ${red("✗")} ${final || text}\n`);
    },
  };
}
