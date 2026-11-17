# Private contact values

In a department's External messaging section, choose **Add address**, enter the consent details and add field names and values. For example, `name`, `organization` and `personal_line`. This saves a contact and consent; sending still follows the channel's existing checks.

For a table, choose **Import CSV or XLSX**. Use the first worksheet for XLSX. The included examples use synthetic contacts:

- [CSV example](contacts-example.csv)
- [XLSX example](contacts-example.xlsx)

Every row needs an `address` and explicit `consent`: `yes`, `true` or `1`. Other columns are contact fields. In the form, record where these people consented and what confirms that consent. A missing address or consent skips the row. The result gives counts and each skipped row's number and reason, without its values. An existing refusal stays in force.

Names use lowercase Latin letters, digits and underscores, starting with a letter, up to 80 characters. `account_label` and `channel_name` are reserved sender fields. Each contact has up to 50 fields. Values are one nonempty plain line, up to 200 characters. Files are limited to 2 MiB and 1000 data rows; duplicate or invalid headers, formulas and malformed workbooks are refused. Blank cells omit a field. Adding an existing contact merges the supplied fields with that department's stored values.

The department head can call `outbound_contact_add` with `channel`, `kind`, `address`, `source`, `evidence` and optional `fields`. It uses the existing person authority, returns ids only and does not send a message. Contact values remain encrypted and scoped to the department; contact lists and setup logs do not expose them.

For a template variable, publish a variable catalog entry whose `field` is the matching contact field name. The existing `outbound_submit` document continues to reference that catalog entry. Missing values refuse that recipient with `contact_field_missing`; invalid or unsafe values are refused too. Other recipients can proceed independently. A value change after a message was queued invalidates its old sealed content, so the message must be submitted again and pass the usual checks.
