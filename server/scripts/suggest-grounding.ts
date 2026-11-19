/** Checks that AI suggestion reasons naming titles the viewer never watched are rejected. npx tsx scripts/suggest-grounding.ts */
import { reasonIsGrounded as g } from '../src/suggest.ts';
const h = ['Drishyam: The Conclusion', 'Spider-Man: Brand New Day', 'The Odyssey', 'The Beast'];
const cases: [string, string, boolean][] = [
  ['Epic action and adventure appeal to your taste like Game of Thrones.', 'Avengers: Endgame', false],
  ['An action crime thriller is similar to Dhurandhar.', 'Dhurandhar', false],
  ['An epic adventure fits your love for stories like Ramayana.', 'Ramayana: Rise of a Legend', false],
  ['A mystery thriller similar to Drishyam appeals to your taste.', 'Drishyam', false],
  ['A twisty Hindi crime thriller like Drishyam: The Conclusion', 'Raid 2', true],
  ['A Greek epic adventure like The Odyssey', 'Troy', true],
  ['More web-slinging action like Spider-Man', 'Spider-Man: No Way Home', true],
  ['A psychological thriller matches your enjoyment of mystery.', 'Shutter Island', true],
  ['Epic action and adventure fit the scale of Game of Thrones The IMAX Experience.', 'Avengers: Endgame', false],
  ['Mystery and action align with the suspense of Shutter Island.', 'Ghost Soldier', false],
  ['Action and adventure appeal matches Spider-Man: Brand New Day.', 'Spider-Man: No Way Home', true],
  ['A gripping Hindi crime saga full of twists.', 'Raid 2', true],
  ['Marvel heroes team up in an epic Sci-Fi battle.', 'Avengers: Endgame', true],
];
for (const [r, self, want] of cases) console.log(g(r, self, h) === want ? 'ok  ' : 'FAIL', r);
process.exit(0);
