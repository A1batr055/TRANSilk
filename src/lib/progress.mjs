
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function withSpinner(label, task) {
  if (!process.stdout.isTTY) {
    return task();
  }

  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${FRAMES[i = (i + 1) % FRAMES.length]} ${label}`);
  }, 80);

  try {
    const result = await task();
    process.stdout.write(`\r✓ ${label}\n`);
    return result;
  } catch (err) {
    process.stdout.write(`\r✗ ${label}\n`);
    throw err;
  } finally {
    clearInterval(timer);
  }
}
