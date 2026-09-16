import { mkdir } from 'node:fs/promises';

await mkdir('outputs/private', { recursive: true });
