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
    expect(laws).toMatch(/medium and look[\s\S]*required method of capture/i);
    expect(laws).toMatch(/planning sketch[\s\S]*approved production asset/i);
    expect(laws).toMatch(/shared set plan[\s\S]*where the layout matters/i);
    expect(laws).toMatch(/hardest moment[\s\S]*materially different risk/i);
    expect(laws).toMatch(/destination's verified format, viewing area and playback conditions/i);
    /* The brief's words keep their ordinary meaning, and nothing carries over from an earlier order. */
    expect(laws).toMatch(/film or cinematic look[\s\S]*live action[\s\S]*cartoon[\s\S]*animation/i);
    expect(laws).toMatch(/each order starts from its own brief[\s\S]*earlier video/i);
    /* Planning drawings explain the scenes; the video is made fresh. */
    expect(laws).toMatch(/never the material the shots are made from[\s\S]*never copied frame by frame/i);
    /* A key event is shown, not implied by a cut, and pace comes from inside the shots. */
    expect(laws).toMatch(/inside a shot[\s\S]*never left to a cut between two shots/i);
    expect(laws).toMatch(/pace comes from the action and the camera inside the shots/i);
    /* The set is a measured layout with named markers. */
    expect(laws).toMatch(/measured 3D layout[\s\S]*named markers/i);
    /* Exact geometry is made in the edit, not left to generation. */
    expect(laws).toMatch(/exact geometry[\s\S]*in the edit/i);
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

  it('uses included video credits first and keeps each order within its spending limit', () => {
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/included credits[\s\S]*studio[\s\S]*developer credits[\s\S]*before pay-per-use/i);
    expect(work).toMatch(/spending limit and currency for each order[\s\S]*stop before the order can exceed its limit/i);
    expect(work).toMatch(/cheaper modes for drafts[\s\S]*quality mode for accepted finals/i);
    expect(work).toMatch(/record the route, model, settings[\s\S]*actual cost/i);
  });

  it('lets an agent work a browser studio like a person when the account holder allows it and the terms do not forbid it', () => {
    const laws = templates.skills.get('vid-laws')!.body.split('## Law 7.')[1]?.split('## Law 8.')[0];
    expect(laws).toMatch(/authorized tool and access route/i);
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/check[\s\S]*models, prices, limits and terms[\s\S]*on the day/i);
    expect(work).toMatch(/agent may operate a browser studio when the account holder authorizes it and the provider's terms do not forbid it[\s\S]*one job at a time[\s\S]*stops at any warning[\s\S]*terms forbid[\s\S]*person[\s\S]*documented API or official connector/i);
    expect(work).toMatch(/operator[\s\S]*named vault entry[\s\S]*signs in[\s\S]*protected sign-in surface/i);
    expect(work).toMatch(/check the existing job before retrying/i);
  });

  it('uses each maker\'s prompt structure and compares models using accepted probe evidence', () => {
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/before using a model[\s\S]*maker's current prompt guide[\s\S]*model's structure/i);
    expect(work).toMatch(/same references and acceptance conditions[\s\S]*chosen route[\s\S]*fallback/i);
    expect(work).toMatch(/short note per model[\s\S]*notebook[\s\S]*what worked[\s\S]*settings[\s\S]*cost per accepted second[\s\S]*probe file/i);
    const short = templates.catalogs.get('video_production')!.pipelines[0]!;
    expect(short.stages.find(stage => stage.name === 'Prove the hardest shot')?.brief).toMatch(/route, model, settings, cost and fallback/i);
    expect(short.stages.find(stage => stage.name === 'Make or capture draft shots')?.brief).toMatch(/model's prompt guide/i);
  });

  it('offers a long-work pipeline next to the short default and finishes before the whole-work gate', () => {
    const catalog = templates.catalogs.get('video_production')!;
    expect(catalog.default).toBe('video-production');
    const long = catalog.pipelines[1];
    expect(long).toMatchObject({ key: 'video-long-work', name: 'Long video production', why: 'For a film, a series or a work with many scenes or places.' });
    expect(long!.stages.map(stage => stage.name)).toEqual([
      'Write the brief', 'Write the story', 'Keep the production guide', 'Break down sequences and scenes', 'Prove the hardest moment',
      'Make the scenes', 'Assemble and lock the cut', 'Finish and export the master', 'Check the whole work', 'Deliver the accepted master',
    ]);
    expect(long!.stages[2]?.brief).toMatch(/character sheets[\s\S]*sets with markers[\s\S]*look book[\s\S]*color script[\s\S]*sound palette/i);
    expect(long!.stages[7]?.brief).toMatch(/Law 10[\s\S]*colorist[\s\S]*sound designer[\s\S]*editor/i);
    expect(long!.stages[8]).toMatchObject({ ownerRole: 'VID-QA', brief: expect.stringContaining('Law 11') });
  });

  it('runs scenes in parallel through the short pipeline and sends bible changes to every affected scene', () => {
    const long = templates.catalogs.get('video_production')?.pipelines.find(p => p.key === 'video-long-work');
    const scenes = long?.stages.find(s => s.name === 'Make the scenes')?.brief;
    expect(scenes).toMatch(/each scene[\s\S]*own task[\s\S]*in parallel[\s\S]*video-production[\s\S]*script[\s\S]*keeper's gate[\s\S]*edit/i);
    expect(scenes).toMatch(/bible's approved story, sheets, sets and look references[\s\S]*lead keeper and the director[\s\S]*every affected scene/i);
  });

  it('lets the brief choose the way shots are made and keeps usable footage', () => {
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/film brief calls for live action[\s\S]*cartoon calls for animation/i);
    expect(work).toMatch(/use camera capture when the brief requires/i);
    const stages = templates.catalogs.get('video_production')!.pipelines[0]!.stages;
    expect(stages.find(stage => stage.name === 'Make or capture draft shots')).toMatchObject({ ownerRole: 'VID-GEN', echelon: 'development' });
    expect(stages.find(stage => stage.name === 'Prepare final shots and required pickups')?.brief).toMatch(/keep accepted drafts and recordings/i);
  });

  it('gives the writer the story, the director the creative decisions and the keeper custody of the bible', () => {
    const long = templates.catalogs.get('video_production')!.pipelines.find(p => p.key === 'video-long-work')!;
    expect(long.stages[1]).toMatchObject({ ownerRole: 'VID-WRITE', brief: expect.stringMatching(/director approves[\s\S]*story line/i) });
    expect(long.stages[2]).toMatchObject({ ownerRole: 'VID-KEEP', brief: expect.stringContaining('approved story') });
    expect(long.stages.find(stage => stage.name === 'Make the scenes')?.brief).toMatch(/story and performance[\s\S]*setup or payoff/i);
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/premise[\s\S]*beats[\s\S]*scene objective[\s\S]*setups and payoffs/i);
    expect(work).toMatch(/director approves[\s\S]*story line[\s\S]*shot plan[\s\S]*preferred performances/i);
  });

  it('plans film craft in the working skill and proves new risks against a shared baseline', () => {
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/cinematographer[\s\S]*production designer/i);
    expect(work).toMatch(/shot list[\s\S]*shot size[\s\S]*angle[\s\S]*lens[\s\S]*camera movement[\s\S]*coverage/i);
    expect(work).toMatch(/motivated light[\s\S]*look book[\s\S]*color script/i);
    expect(work).toMatch(/play the join[\s\S]*shared baseline[\s\S]*materially different risk/i);
    for (const look of ['Live action', '3D animation', '2D animation', 'Anime', 'Stop motion', 'Motion graphics', 'Screen recording']) {
      expect(work).toContain(`**${look}.**`);
    }
    const long = templates.catalogs.get('video_production')!.pipelines.find(p => p.key === 'video-long-work')!;
    expect(long.stages.find(stage => stage.name === 'Prove the hardest moment')?.brief).toMatch(/shared baseline[\s\S]*materially different risk/i);
  });

  it('plans sound early and reviews an assembly, rough cut and fine cut before picture lock', () => {
    const work = templates.skills.get('vid-work-pipeline')!.body;
    expect(work).toMatch(/sound from the start[\s\S]*room tone[\s\S]*temporary tracks/i);
    expect(work).toMatch(/assembly[\s\S]*rough cut[\s\S]*fine cut[\s\S]*notes after each pass[\s\S]*locks picture/i);
    expect(work).toMatch(/cut on action[\s\S]*J cut[\s\S]*L cut/i);
    const short = templates.catalogs.get('video_production')!.pipelines[0]!;
    expect(short.stages.find(stage => stage.name === 'Edit the draft cut')?.brief).toMatch(/music, exact geometry, titles and an end card only where the brief needs them/i);
  });

  it('has every route play the actual exported master at normal speed before delivery', () => {
    for (const route of templates.catalogs.get('video_production')!.pipelines) {
      const watch = route.stages.findIndex(stage => /play the exact exported master at normal speed/i.test(stage.brief ?? ''));
      expect(watch, route.key).toBeGreaterThanOrEqual(0);
      expect(route.stages.slice(watch).some(stage => /deliver the accepted master/i.test(`${stage.name} ${stage.brief}`)), route.key).toBe(true);
    }
    const laws = templates.skills.get('vid-laws')!.body.split('## Law 11.')[1];
    expect(laws).toMatch(/exact version intended for delivery/i);
  });

  it('records screen direction and exact takes while allowing a reasoned continuity break', () => {
    expect(templates.roles.get('VID-KEEP')?.title.en).toBe('Script supervisor and continuity keeper');
    const continuity = templates.skills.get('vid-continuity')!.body;
    expect(continuity).toMatch(/180-degree rule[\s\S]*eyelines[\s\S]*match on action/i);
    expect(continuity).toMatch(/continuity sheet[\s\S]*story day[\s\S]*entry and exit/i);
    expect(continuity).toMatch(/play the exact clip[\s\S]*director approves[\s\S]*record the reason[\s\S]*check the break in context[\s\S]*check the replacement/i);
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
