// TCP proxy that limits server→browser bandwidth, to simulate a remote client on a
// slow link. Used by `lumiverse.sh e2e --slow`.
//   node throttle-proxy.mjs <listenPort> <targetPort> <bytesPerSecond>
import net from 'node:net';

const [listenPort, targetPort, rate] = process.argv.slice(2).map(Number);
const TICK_MS = 50;
const perTick = Math.max(1, Math.floor((rate * TICK_MS) / 1000));

net
  .createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    client.pipe(upstream);
    const queue = [];
    let queued = 0;
    upstream.on('data', (chunk) => {
      queue.push(chunk);
      queued += chunk.length;
      if (queued > 512 * 1024) upstream.pause(); // push back on the server like a slow link
    });
    const timer = setInterval(() => {
      let budget = perTick;
      while (budget > 0 && queue.length > 0) {
        const head = queue[0];
        const part = head.length <= budget ? queue.shift() : head.subarray(0, budget);
        if (part !== head) queue[0] = head.subarray(budget);
        budget -= part.length;
        queued -= part.length;
        client.write(part);
      }
      if (queued < 256 * 1024 && upstream.isPaused()) upstream.resume();
    }, TICK_MS);
    const close = () => {
      clearInterval(timer);
      client.destroy();
      upstream.destroy();
    };
    upstream.on('end', () => {
      const drain = setInterval(() => {
        if (queue.length === 0) {
          clearInterval(drain);
          close();
        }
      }, TICK_MS);
    });
    client.on('close', close);
    client.on('error', close);
    upstream.on('error', close);
  })
  .listen(listenPort, '127.0.0.1', () => console.log(`throttling :${listenPort} -> :${targetPort} at ${rate} B/s`));
