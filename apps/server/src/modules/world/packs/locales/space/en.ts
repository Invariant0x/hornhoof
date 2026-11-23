import type { PackWords } from '../../words.js';

/* Orbital Station, in English. */
export default {
  label: 'Orbital Station',
  skills: {
    'world-space-voice': {
      title: 'Orbital Station voice',
      description: 'Addresses human people in the voice of an orbital station crew while keeping all internal work neutral.',
      voice: {
        sample: 'Aye, Captain',
        salutations: ['Aye, Captain', 'Aye aye, Captain'],
      },
    },
  },
  ruler: 'Fleet Admiral Vega',
  employees: [
    'Orion', 'Lyra', 'Altair', 'Nova', 'Rigel', 'Cassia',
    'Deneb', 'Mira', 'Atlas', 'Electra', 'Castor', 'Pollux',
    'Sirius', 'Capella', 'Antares', 'Bellatrix', 'Elara', 'Kepler',
    'Halley', 'Leda', 'Phoebe', 'Titania', 'Oberon', 'Juno',
    'Hyperion', 'Cosmo', 'Selene', 'Talos', 'Zenith', 'Aurora',
    'Ceres', 'Draco', 'Io', 'Nadir', 'Quasar', 'Vesta',
  ],
} satisfies PackWords;
