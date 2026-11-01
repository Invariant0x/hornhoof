const schema = {
  url() { return this; },
  min() { return this; },
  regex() { return this; },
  safeParse(data) { return { success: true, data }; },
  parse(data) { return data; },
};

export const z = {
  object: () => schema,
  string: () => schema,
  enum: () => schema,
};
