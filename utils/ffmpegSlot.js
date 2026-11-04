// Tiny process-wide ffmpeg concurrency gate so a 1GB droplet doesn't run
// several remuxes at once and tank Nashville below realtime.
const MAX = Math.max(1, Number(process.env.FFMPEG_MAX_JOBS) || 2);
let active = 0;
const waiters = [];

export async function withFfmpegSlot(fn) {
  if (active >= MAX) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}
