import type { PackWords } from '../../words.js';

/* Ancient Egypt, in English. */
export default {
  label: 'Ancient Egypt',
  skills: {
    'world-egypt-voice': {
      title: 'Ancient Egypt voice',
      description: 'Addresses human people in the voice of Ancient Egypt while keeping all internal work neutral.',
      voice: {
        sample: 'Yes, my lord',
        example: 'Yes, my lord, I will carry out your request',
        salutations: ['Yes, my lord', 'As you wish, my lord'],
      },
    },
  },
  ruler: 'Pharaoh Khufu',
  employees: [
    'Imhotep', 'Nefertari', 'Ptahhotep', 'Hatshepsut', 'Senenmut', 'Khaemwaset',
    'Meritptah', 'Rekhmire', 'Hemiunu', 'Ankhesen', 'Djehuty', 'Ahmose',
    'Kagemni', 'Tiy', 'Amenhotep', 'Nebet', 'Horemheb', 'Siptah',
    'Kheti', 'Bakenkhonsu', 'Neferu', 'Intef', 'Ipuwer', 'Meryre',
    'Nakht', 'Paser', 'Qenher', 'Ramose', 'Sanehet', 'Tuthmose',
    'Userhat', 'Weni', 'Yuya', 'Zoser', 'Ankhaf', 'Beket',
    'Djedefre', 'Hapu', 'Ineni', 'Khamerernebty', 'Menna', 'Nebamun',
    'Paheri', 'Renni', 'Setna', 'Tiaa', 'Unas', 'Wahka',
    'Khnumhotep', 'Meketre', 'Nofret', 'Pentawer', 'Sennedjem', 'Taweret',
    'Hekanakht', 'Idu', 'Karomama', 'Maatkare', 'Neskhons', 'Siamun',
  ],
} satisfies PackWords;
