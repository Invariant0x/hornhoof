import { describe } from 'vitest';
import { registerAnswerCases } from './decisions-company.js';

describe('who may answer, by decision rights', () => {
  registerAnswerCases(['devQuestion','salesQuestion']);

});
