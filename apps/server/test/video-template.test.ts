import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const DIR = new URL('../../../templates/', import.meta.url);
const templates = loadTemplates(fileURLToPath(DIR));

describe('the laws of video production', () => {
  it('ships the ten laws in one skill without company, product or provider names from the original order', () => {
    const skill = templates.skills.get('vid-laws');
    expect(skill).toBeDefined();
    expect(skill!.body.match(/^## Law .*$/gm)).toEqual([
      '## Law 1. The brief\'s look governs every frame',
      '## Law 2. Planning material explains, it does not dictate',
      '## Law 3. What matters happens on screen',
      '## Law 4. One world, held still',
      '## Law 5. The set is built before it is filmed',
      '## Law 6. A keeper holds the look and the world',
      '## Law 7. Each tool does what it does best',
      '## Law 8. Prove the hardest moment first',
      '## Law 9. The platform shapes the frame',
      '## Law 10. Judge the finished video, not the effort',
    ]);
    const files = [
      ...[...templates.roles.values()].filter(role => role.id.startsWith('VID-')).map(role => `roles/video_production/${role.id}.md`),
      ...[...templates.skills.keys()].filter(id => id.startsWith('vid-')).map(id => `skills/${id}.md`),
      'teams/video_production/VID-TEAM.md', 'echelons/video_production.md', 'pipelines/video_production.md',
    ];
    for (const path of files) {
      const text = readFileSync(new URL(path, DIR), 'utf8');
      expect(text, path).not.toMatch(/ArSpatially|Hornhoof|\b(?:Ivan|Kling|Runway|Veo|Sora)\b|[\u2013\u2014\u0401\u0451]/i);
      expect(readFileSync(new URL('SOURCES.md', DIR), 'utf8'), path).toContain(`| \`${path}\` |`);
    }
  });

  it('assigns each production role the shared laws and gives only the keeper the continuity gate', () => {
    const roles = {
      'VID-HEAD': 'Laws 1, 8 and 10', 'VID-WRITE': 'Laws 1, 2 and 3', 'VID-BOARD': 'Laws 2 and 5',
      'VID-KEEP': 'Laws 4, 5 and 6', 'VID-GEN': 'Laws 3, 4 and 7', 'VID-EDIT': 'Laws 3, 7 and 9', 'VID-QA': 'Laws 1 to 10',
    };
    for (const [id, laws] of Object.entries(roles)) expect(templates.roles.get(id)?.body, id).toContain(laws);
    const roster = [...templates.roles.values()].filter(role => role.id.startsWith('VID-'));
    for (const role of roster) expect(role.skills, role.id).toContainEqual(expect.objectContaining({ id: 'vid-laws', on: true }));
    expect(roster.filter(role => role.skills.some(skill => skill.id === 'vid-continuity')).map(role => role.id)).toEqual(['VID-KEEP']);
    const route = [...templates.echelons.values()].find(entry => entry.department === 'video_production');
    expect(route?.stages).toContainEqual({ stage: 'review', ability: 'vid-continuity' });
  });

  it('sets up the video service through the vault while leaving the agent on its regular plan', () => {
    const head = templates.roles.get('VID-HEAD');
    expect(head?.skills).toContainEqual(expect.objectContaining({ id: 'vid-work-pipeline', on: true }));
    const setup = templates.skills.get('vid-work-pipeline')?.body;
    expect(setup).toMatch(/ask for a video generation API key/i);
    expect(setup).toMatch(/vault[\s\S]*spending limit[\s\S]*usual subscription/i);
    expect(setup).toMatch(/an aggregator API with several video models[\s\S]*the model maker's API/i);
    expect(setup).toMatch(/consumer subscriptions[\s\S]*no API/i);
    expect(setup).toMatch(/prompts[\s\S]*reference frames[\s\S]*cost[\s\S]*git/i);
    expect(templates.skills.get('orch-company')?.body).toContain('vid-work-pipeline');
  });
});
