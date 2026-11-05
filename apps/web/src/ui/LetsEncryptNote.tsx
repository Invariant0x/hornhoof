import { useT } from '../i18n';

/* Let's Encrypt's page of its current Subscriber Agreement. */
const AGREEMENT_URL = 'https://letsencrypt.org/repository/';

/* The link's certificate comes from Let's Encrypt, and getting it accepts their agreement for the company. */
export function LetsEncryptNote() {
  const { before, agreement, after } = useT().link.letsEncrypt;
  return (
    <p className="update-note">
      {before}
      <a href={AGREEMENT_URL} target="_blank" rel="noreferrer">{agreement}</a>
      {after}
    </p>
  );
}
