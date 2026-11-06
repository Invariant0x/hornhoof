export const COMPANY = '00000000-0000-4000-8000-000000000001';
export const PERSON = '00000000-0000-4000-8000-000000000002';
export const FIRST = '00000000-0000-4000-8000-000000000005';
export const ANSWERED = '00000000-0000-4000-8000-000000000007';
export const COMMIT = 'a'.repeat(40);
export const HISTORY = { schemaVersion: 1, versions: [] };
export const LEGACY = `
  INSERT INTO companies(id,name) VALUES ('${COMPANY}','Question migration fixture');
  INSERT INTO people(id,company_id,name,email,status,scope_kind,is_owner) VALUES
    ('${PERSON}','${COMPANY}','Real decision maker','question-fixture@example.test','active','company',true);
  INSERT INTO agents(id,company_id,kind,name,model) VALUES
    ('00000000-0000-4000-8000-000000000003','${COMPANY}','worker','Source author','');
  INSERT INTO tasks(id,company_id,number,title) VALUES
    ('00000000-0000-4000-8000-000000000004','${COMPANY}',1,'Retained task');
  INSERT INTO requests(id,company_id,task_id,agent_id,kind,text,status,answer,answered_by,answered_at,commit) VALUES
    ('${FIRST}','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Original technical question','open',null,null,null,null),
    ('00000000-0000-4000-8000-000000000006','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Independent second question','open',null,null,null,null),
    ('${ANSWERED}','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Historical question','answered','Actual human answer','${PERSON}','2026-11-05T01:00:00Z',null),
    ('00000000-0000-4000-8000-000000000008','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','approval','Approved exact result','approved','Approved by person','${PERSON}','2026-11-05T01:00:00Z','${COMMIT}'),
    ('00000000-0000-4000-8000-000000000009','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','approval','Declined exact result','declined','Declined by person','${PERSON}','2026-11-05T01:00:00Z','${'b'.repeat(40)}');
  INSERT INTO request_internal(request_id,company_id,material_snapshot) VALUES ('${FIRST}','${COMPANY}','${JSON.stringify(HISTORY)}');
  INSERT INTO proposals(id,company_id,agent_id,brief,items,status,applied_by,applied_at) VALUES
    ('00000000-0000-4000-8000-000000000010','${COMPANY}','00000000-0000-4000-8000-000000000003','Private pending staff proposal','[]','pending',null,null),
    ('00000000-0000-4000-8000-000000000011','${COMPANY}','00000000-0000-4000-8000-000000000003','Historical applied proposal','[]','applied','${PERSON}','2026-11-05T01:00:00Z'),
    ('00000000-0000-4000-8000-000000000012','${COMPANY}','00000000-0000-4000-8000-000000000003','Historical dismissed proposal','[]','dismissed',null,null);
`;
