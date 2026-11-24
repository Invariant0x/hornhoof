import type { PackWords } from '../../words.js';

/* Subterranean Dungeon, in English. */
export default {
  label: 'Subterranean Dungeon',
  skills: {
    'world-dungeon-voice': {
      title: 'Subterranean Dungeon voice',
      description: 'Addresses human people in the voice of the Subterranean Dungeon while keeping all internal work neutral.',
      voice: {
        sample: 'As you command, Keeper of the Deep',
        salutations: ['As you command, Keeper of the Deep', 'Keeper of the Deep'],
      },
    },
  },
  ruler: 'Delve Lord Borin',
  employees: [
    'Thrain', 'Veyra', 'Orsik', 'Durn', 'Kaelith', 'Brimstone',
    'Rurik', 'Helga', 'Tordek', 'Nala', 'Barendd', 'Morgran',
    'Torbera', 'Flint', 'Eberk', 'Dagnal', 'Brottor', 'Vistra',
    'Delg', 'Kildrak', 'Sannl', 'Ulfgar', 'Mardred', 'Taklinn',
    'Harbek', 'Kathra', 'Rangrim', 'Eldeth', 'Baern', 'Riswynn',
    'Adrik', 'Audhild', 'Darrak', 'Falkrunn', 'Gardain', 'Gunnloda',
    'Oskar', 'Ilde', 'Traubon', 'Diesa', 'Veit', 'Liftrasa',
  ],
} satisfies PackWords;
