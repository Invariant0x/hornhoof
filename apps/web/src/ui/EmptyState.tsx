import { TrackerIcon } from './icons';

type Picture = Parameters<typeof TrackerIcon>[0]['name'];

/* The one thing a person can do about a section that holds nothing, as the + beside Tasks offers it there. */
export type EmptyAction = { label: string; onClick: () => void };

/* What a section of the tracker says once every source of it came and it holds nothing (#1638): its picture, its words and,
   where the person can do something about it, the one thing to do. Its look is the CSS of its own classes, so Design's
   empty state (#1633) is a change of styles and words. status: its words are the section's one status. */
export function EmptyState({ picture, text, action, status }: { picture: Picture; text: string; action?: EmptyAction; status?: boolean }) {
  return (
    <div className="empty-state" role={status ? 'status' : undefined}>
      <span className="empty-state-art" aria-hidden="true"><TrackerIcon name={picture} /></span>
      <p className="empty-state-text" dir="auto">{text}</p>
      {action && <button className="btn small empty-state-action" type="button" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
