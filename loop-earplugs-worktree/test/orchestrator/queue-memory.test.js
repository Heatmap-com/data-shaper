import { describeQueueContract } from './queue-contract.js';
import { createStore } from '../../src/orchestrator/adapters/queue/memory.js';

describeQueueContract('memory', async (clock) => createStore({ clock }));
