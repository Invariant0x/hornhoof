/* Why a sign-in from Hornhoof did not finish, as the node says it in login.done. The web words each in the person's
   language. It lives apart from the message schemas, so the web takes it without the schema library. */
export const SIGNIN_ERRORS = {
  stopped: 'The sign-in was stopped.',
  unfinished: 'The sign-in ended before it finished, so nothing changed.',
  notTaken: 'The program did not take the new sign-in, so nothing changed.',
  broke: 'The sign-in failed on this machine, so nothing changed.',
  noLogin: 'This machine cannot run the sign-in for its plan from Hornhoof.',
  noProgram: 'The program could not be installed on this machine, so nothing changed.',
} as const;

export type SigninError = keyof typeof SIGNIN_ERRORS;
