import { backendContract } from './backend.contract';
import { memoryBackend } from './memory';

backendContract('memory', async () => memoryBackend());
