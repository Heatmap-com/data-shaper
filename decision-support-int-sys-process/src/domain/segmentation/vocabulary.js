import { CHANNEL_TABLES } from '../channel-rules/rules.js';
import { deepFreeze } from '../freeze.js';
import { FIELDS } from './fields.js';
import { LISTS } from './lists.js';

/** What a declaration may read: the fields, the lists, and the channel tables as bases. */
export const SEGMENTATION_VOCABULARY = deepFreeze({ fields: FIELDS, lists: LISTS, bases: CHANNEL_TABLES });
