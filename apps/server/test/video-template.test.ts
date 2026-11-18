import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const DIR = new URL('../../../templates/', import.meta.url);
const templates = loadTemplates(fileURLToPath(DIR));

describe('the laws of video production', () => {
  it('ships the eleven laws in one skill without company, product or provider names', () => {
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
      '## Law 10. The whole work is finished as one',
      '## Law 11. Judge the finished video, not the effort',
    ]);
    const files = [
      ...[...templates.roles.values()].filter(role => role.id.startsWith('VID-')).map(role => `roles/video_production/${role.id}.md`),
      ...[...templates.skills.keys()].filter(id => id.startsWith('vid-')).map(id => `skills/${id}.md`),
      'teams/video_production/VID-TEAM.md', 'echelons/video_production.md', 'pipelines/video_production.md',
    ];
    for (const path of files) {
      const text = readFileSync(new URL(path, DIR), 'utf8');
      expect(text, path).not.toMatch(/ArSpatially|Hornhoof|\b(?:Ivan|Kling|Runway|Veo|Sora|Shorts|Reels|TikTok)\b|[\u2013\u2014\u0401\u0451]/i);
      expect(readFileSync(new URL('SOURCES.md', DIR), 'utf8'), path).toContain(`| \`${path}\` |`);
    }
  });

  it('makes the look, set, probe and platform fit the brief', () => {
    const laws = templates.skills.get('vid-laws')!.body;
    expect(laws).not.toMatch(/real failure|mean live-action film|5 to 8 s/i);
    expect(laws).toMatch(/planning sketch[\s\S]*approved production asset/i);
    expect(laws).toMatch(/real or drawn[\s\S]*screen recording/i);
    expect(laws).toMatch(/hardest moment[\s\S]*few seconds/i);
    expect(laws).toMatch(/destination[\s\S]*for example, a short vertical video/i);
  });

  it('assigns clip acceptance explicitly and reserves text judging for written proposals', () => {
    const plan = templates.skills.get('vid-work-pipeline')!.body;
    expect(plan).toMatch(/stage owner assigns[\s\S]*qualified substitute/i);
    const route = templates.stagesOf('video_production');
    expect(route.stages[0]?.oneShot?.judge).toMatch(/written proposals[\s\S]*cannot verify footage/i);
    const catalog = templates.catalogs.get('video_production')!;
    const footage = catalog.pipelines.find(p => p.key === 'video-footage-editing')!;
    const names = footage.stages.map(s => s.name);
    expect(names.indexOf('Check the footage')).toBeLessThan(names.indexOf('Prove the hardest edit'));
  });

  it('finishes the whole work against the probe reference before judging the result', () => {
    const finish = templates.skills.get('vid-laws')?.body.split('## Law 10.')[1]?.split('## Law 11.')[0];
    expect(finish).toMatch(/color, contrast, grain, sound and titles[\s\S]*each by one owner[\s\S]*one look reference/i);
    expect(finish).toMatch(/probe \(Law 8\)[\s\S]*reference frames for each scene[\s\S]*color script[\s\S]*on purpose/i);
    expect(finish).toMatch(/levels, color balance, skin tones[\s\S]*loudness, voices and room tone/i);
    expect(finish).toMatch(/world, scale or motion \(Laws 4 to 6\)[\s\S]*made again/i);
    const routes = templates.catalogs.get('video_production')!.pipelines;
    for (const key of ['video-production', 'video-footage-editing', 'video-screen-recording']) {
      expect(routes.find(route => route.key === key)?.stages.at(-1)?.brief, key).toMatch(/Law 10[\s\S]*Law 11/);
    }
  });

  it('applies the laws to a short clip and a feature film with a work level above the scenes', () => {
    const intro = templates.skills.get('vid-laws')?.body.split('## Law 1.')[0];
    expect(intro).toMatch(/short clip[\s\S]*feature film[\s\S]*work level above the scenes/i);
  });

  it('assigns each production role the shared laws and gives only the keeper the continuity gate', () => {
    const roster = [...templates.roles.values()].filter(role => role.id.startsWith('VID-'));
    for (const role of roster) expect(role.skills, role.id).toContainEqual(expect.objectContaining({ id: 'vid-laws', on: true }));
    expect(roster.filter(role => role.skills.some(skill => skill.id === 'vid-continuity')).map(role => role.id)).toEqual(['VID-KEEP']);
    const route = [...templates.echelons.values()].find(entry => entry.department === 'video_production');
    expect(route?.stages).toContainEqual({ stage: 'review', ability: 'vid-continuity' });
  });

  it('gives finishing to a colorist and a sound designer and lets the head assign both duties to the editor on a short video', () => {
    const color = templates.roles.get('VID-COLOR');
    expect(color?.title).toEqual({ en: 'Colorist', ru: 'Колорист' });
    expect(color?.body).toMatch(/color, contrast and grain across the whole video/i);
    const sound = templates.roles.get('VID-SOUND');
    expect(sound?.title).toEqual({ en: 'Sound designer', ru: 'Звукорежиссер' });
    expect(sound?.body).toMatch(/sound plan and final mix/i);
    expect(templates.skills.get('vid-work-pipeline')?.body).toMatch(/for a short video the head may give both finishing duties to the editor/i);
    expect(templates.skills.get('vid-continuity')?.body).toMatch(/one lead keeper[\s\S]*shared sheets and sets[\s\S]*other keepers check their scenes against the shared records/i);
  });

  it('sets up the video service through the vault while leaving the agent on its regular plan', () => {
    const head = templates.roles.get('VID-HEAD');
    expect(head?.skills).toContainEqual(expect.objectContaining({ id: 'vid-work-pipeline', on: true }));
    const setup = templates.skills.get('vid-work-pipeline')?.body;
    expect(setup).toMatch(/existing account[\s\S]*named vault entry[\s\S]*protected sign-in surface[\s\S]*spending limit[\s\S]*usual subscription/i);
    expect(setup).toMatch(/prompts[\s\S]*reference frames[\s\S]*cost[\s\S]*git/i);
  });

  it('offers a long-work pipeline next to the short default and finishes before the whole-work gate', () => {
    const catalog = templates.catalogs.get('video_production')!;
    expect(catalog.default).toBe('video-production');
    const long = catalog.pipelines[1];
    expect(long).toMatchObject({ key: 'video-long-work', name: 'Long video production', why: 'For a film, a series or a work with many scenes or places.' });
    expect(long!.stages.map(stage => stage.name)).toEqual([
      'Write the brief', 'Write the story and make a production guide', 'Break down sequences and scenes', 'Prove the hardest moment',
      'Make the scenes', 'Assemble the cut', 'Finish color, sound and titles', 'Check the whole work', 'Prepare and deliver the final version',
    ]);
    expect(long!.stages[1]?.brief).toMatch(/character sheets[\s\S]*sets with markers[\s\S]*look book[\s\S]*color script[\s\S]*sound palette/i);
    expect(long!.stages[6]?.brief).toMatch(/Law 10[\s\S]*colorist[\s\S]*sound designer[\s\S]*editor/i);
    expect(long!.stages[7]).toMatchObject({ ownerRole: 'VID-QA', brief: expect.stringContaining('Law 11') });
  });

  it('runs scenes in parallel through the short pipeline and sends bible changes to every affected scene', () => {
    const long = templates.catalogs.get('video_production')?.pipelines.find(p => p.key === 'video-long-work');
    const scenes = long?.stages.find(s => s.name === 'Make the scenes')?.brief;
    expect(scenes).toMatch(/each scene[\s\S]*own task[\s\S]*in parallel[\s\S]*video-production[\s\S]*script[\s\S]*keeper's gate[\s\S]*edit/i);
    expect(scenes).toMatch(/only the bible's sheets, sets and look reference[\s\S]*never changes the bible[\s\S]*lead keeper and the head[\s\S]*every scene it touches/i);
  });

  it('routes Marketing video through the shared laws and the Video production department when it exists', () => {
    for (const id of ['MKT-HEAD', 'MKT-WRITE', 'MKT-SOCIAL', 'MKT-EDIT', 'DSN-HEAD', 'DSN-PM', 'DSN-UI', 'DSN-QA']) {
      expect(templates.roles.get(id)?.skills, id).toContainEqual(expect.objectContaining({ id: 'vid-laws', on: true }));
    }
    const news = templates.catalogs.get('marketing')?.pipelines.find(p => p.key === 'marketing-news-videos');
    expect(news?.stages[0]).toMatchObject({ handoffTo: ['video_production'] });
    const fallback = news?.stages.map(stage => stage.brief ?? '').join('\n');
    expect(fallback).toMatch(/assigns each required check[\s\S]*accepted probe[\s\S]*keeper/i);
    const editing = templates.catalogs.get('design')?.pipelines.find(p => p.key === 'design-video-editing');
    expect(editing?.stages[0]?.brief).toMatch(/assign the keeper and footage check/i);
  });

  it('points Marketing and Design to the final acceptance law', () => {
    for (const [department, key] of [['marketing', 'marketing-news-videos'], ['design', 'design-video-editing']] as const) {
      const pipeline = templates.catalogs.get(department)?.pipelines.find(p => p.key === key);
      expect(pipeline?.stages.map(stage => stage.brief).join('\n'), key).toMatch(/Law 10[\s\S]*Law 11/);
    }
  });

  it('delivers the laws to video roles hired before the laws were added', () => {
    const role = templates.roles.get('MKT-SOCIAL')!;
    const skills: string[] = [];
    const agent = { id: 'a', companyId: 'c', kind: 'worker', name: 'Ari', roleKey: role.id, skills, overrides: {}, templateHashes: {} } as Parameters<typeof renderInstructions>[1];
    const rendered = renderInstructions(templates, agent, { company: 'Company', department: 'Marketing', product: null });
    expect(rendered.skills.find(file => file.name === 'vid-laws')?.body).toContain('## Law 6. A keeper holds the look and the world');
  });
});
