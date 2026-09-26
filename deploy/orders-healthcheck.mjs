try {
  const response = await fetch('http://127.0.0.1:3091/ready', { signal: AbortSignal.timeout(3000) });
  if (!response.ok || (await response.json()).ok !== true) process.exitCode = 1;
} catch { process.exitCode = 1; }
