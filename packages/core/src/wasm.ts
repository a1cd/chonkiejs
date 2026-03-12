import { init as initChunk } from '@chonkiejs/chunk';

let wasmInitialized = false;

export async function initWasm(): Promise<void> {
  if (!wasmInitialized) {
    await initChunk();
    wasmInitialized = true;
  }
}
