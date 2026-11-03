import type { TaskLine } from './types';

/* Search only the tasks the API lets the person see; an exact number precedes word matches. */
export function searchTasks(tasks: TaskLine[], query: string): TaskLine[] {
  const needle = query.trim().toLowerCase();
  const number = Number(/^#?(\d+)$/.exec(needle)?.[1]);
  const words = needle.split(/\s+/);
  return tasks.filter(task => {
    const text = `${task.title} ${task.brief}`.toLowerCase();
    return task.number === number || (needle.length >= 8 && task.id.toLowerCase().startsWith(needle)) || words.every(word => text.includes(word));
  }).sort((a, b) => Number(b.number === number) - Number(a.number === number));
}
