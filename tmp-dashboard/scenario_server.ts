/**
 * Throwaway runner: stands up the testing harness with every scenario in the
 * catalogue, on a fixed port the Vite proxy points at. Ctrl+C to stop.
 */
import {startScenario} from '../src/testing';

async function main(): Promise<void> {
  const server = await startScenario(
    [
      'settled-mixed',
      'parked',
      'retrying',
      'stuck',
      'unserved-queue',
      'split-manifest',
    ],
    {port: 7788},
  );
  console.log(`scenario server ready at ${server.url}`);
}

void main();
