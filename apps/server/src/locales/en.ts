/* What the server says to a person in its own words: why an assistant's call was refused, what a Telegram bot answers, and the
   lines the notices carry. English is the source, as in the screens; every other
   language is a file named by its id that has every text below (index.ts brings them). A text a program reads, such as the
   words an agent is given, is not here: those stay English. */
export const en = {
  assignment: 'Assignment',

  /* Why a call of an assistant was refused, for its owner: one neutral phrase that reads after "<file name> did not come: ",
     so the program puts it after the name of what did not go. The program decides by status and reason, which stay. */
  refusals: {
    assistant_key_invalid: "the assistant's key does not open Hornhoof, because it is wrong, was replaced or taken back, or the assistant is switched off. A new key is made on the assistant's card in People.",
    assistant_owner_inactive: "you are switched off in Hornhoof now, and the company's owner can switch you on again.",
    assistant_agent_refused: 'in Hornhoof you do not write to this employee.',
    agent_unknown: 'there is no such employee in Hornhoof, or they were removed.',
    agent_not_ready: 'the one it goes to cannot answer right now, for example while they have no plan or machine to work on.',
    orchestrator_not_ready: 'the orchestrator cannot answer right now.',
    request_unknown: 'there is no such request in Hornhoof.',
    request_closed: 'this request is answered already.',
    decision_not_allowed: 'this decision is not yours to take in Hornhoof.',
    task_invalid: 'this answer does not fit the request.',
    attachment_unknown: 'there is no such file in Hornhoof, it was deleted after its 30 days, or you cannot open it there.',
    file_empty: 'the file is empty.',
    file_too_big: (megabytes: number) => `the file is bigger than ${megabytes} MB.`,
    file_lost: 'this file was kept on one machine before files had a store, and that machine is gone with it.',
    file_away: 'this file is kept on a machine of the company that is away now. Try again once it is back.',
    file_link_expired: (days: number) => `the link to the file worked for ${days} days, and they are over.`,
    attachment_invalid: "Hornhoof has no room left for the company's files.",
  },

  /* What a bot can say on its own. */
  bot: {
    orchestrator: 'Orchestrator',
    unknown: (id: number, username: string | null) =>
      `I do not know you yet. Ask the company's owner to add your Telegram to your row in People in Hornhoof. Your Telegram number is ${id}${username ? `, your username is ${username}` : ''}.`,
    inactive: "You are not active in the company in Hornhoof now, so I cannot take your message. Ask the company's owner about it.",
    notYours: (agent: string) => `In Hornhoof you cannot write to ${agent}, so I cannot pass your message on. Ask the company's owner if you need to.`,
    unreadable: 'I cannot read this kind of message. Send words, a file, a photo, a video or a voice message.',
    fileLost: (name: string) => `${name} did not come through. Send it again in a little while.`,
    fileTooBig: (name: string, limit: number) => `${name} is too big: a bot gets files of up to ${limit} MB from Telegram. Send it as a link, or in parts.`,
    bigFile: (name: string, url: string, days: number) => `${name} is over 50 MB, more than Telegram passes on. Its link downloads it for ${days} days: ${url}`,
    noRoom: (name: string) => `${name} did not come through: Hornhoof has no room left for the company's files. Ask the company's owner about it.`,
    notReady: (agent: string) => `${agent} cannot answer right now. Open Hornhoof to see why, or write again later.`,
    failed: 'Your message did not go through. Please write it again in a little while.',
    noAnswer: (agent: string) => `${agent} could not answer this time. Open Hornhoof to see why, or write again.`,
  },

  /* How a person wrote the kind of work on the first line of a task's body before tasks carried one: "Kind: bug". Older
     tasks are read by the words of every language. */
  taskKind: { label: 'Kind', bug: 'bug', known_behavior: 'known behavior', unknown_path: 'unknown path', legacy_code: 'legacy code' },

  /* The pages a worker machine serves by itself when it cannot reach the company's server. */
  worker: {
    noLeader: 'This machine cannot reach the company server. Open the company on a machine that keeps its data:',
    server: 'the company server',
    orAt: (url: string) => `or at ${url}.`,
    disconnected: 'This machine was disconnected from the company. To connect it again, get a new command in Hornhoof under Machines and run it here.',
  },

  /* The short line a notice carries beside its source, for the person who reads it in the window of an employee. */
  notices: {
    marked: { read: 'read', done: 'done' },
    machineNoName: 'a machine with no name',
    releaseCi: 'release CI',
    markedCount: (status: string, count: number) => `${status}: ${count}`,
    afterTurn: (turn: string) => `after turn ${turn}`,
    turn: (turn: string) => `turn ${turn}`,
    waitSet: (setter: string, until: string) => `set by ${setter}, until ${until}`,
    queueStill: (agent: string) => `${agent}: queue stands still`,
    runSilent: (work: boolean, run: number, part: number) => `${work ? 'Work' : 'Test'} run ${run}, part ${part} is silent`,
    updateWaits: (machine: string) => `${machine}: update waits`,
    updateCalledOff: 'update called off',
  },

  /* What the program operator's notices say of a program that stopped. */
  operator: {
    cases: {
      assignment_unrecorded: 'assignment words not recorded for sixty seconds',
      recorded_no_activity: 'no first own event for five minutes after the receipt',
      live_words_not_taken: 'three consecutive live deliveries not taken',
      startup_exit: 'program exited within a minute of launch',
      question_waiting: 'program question waiting for thirty seconds',
      not_started: 'a turn ended before its program started',
      node_cannot_work: 'the machine cannot write its work folder',
    },
    named: (name: string, reason: string) => `${name}: ${reason}`,
    wordsOnHold: (name: string) => `${name}: words on hold for more than five minutes`,
    holdNeedsAttention: (name: string) => `${name}: recovery hold needs attention`,
    notStarted: (name: string) => `${name}: a turn ended before its program started`,
  },
};

export type ServerWords = typeof en;
export default en;
