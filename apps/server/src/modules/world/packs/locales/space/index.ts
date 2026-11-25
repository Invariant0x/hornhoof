import { packWords } from '../../words.js';

/* The pack's words in every language of the registry that has a file here, brought by the language's id. */
export default await packWords('space', id => import(`./${id}.js`));
