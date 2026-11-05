CREATE TABLE baskets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    total_cents integer NOT NULL CHECK (total_cents >= 0)
);
