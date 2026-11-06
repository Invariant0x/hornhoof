import { describe } from 'vitest';
import { registerAnswerCases } from './decisions-company.js';

describe('who may answer, by the rules of #49', () => {
  registerAnswerCases(['devQuestion','salesQuestion']);

});
