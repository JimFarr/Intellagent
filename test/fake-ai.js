// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
'use strict';
// Stand-in for the model an extract action asks (claude -p): reads the prompt on stdin and answers the question the
// way a model would, from the ticket text below it; NONE when the ticket doesn't say.
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const question = /Question: (.*)/.exec(prompt)?.[1] || '';
  const ticket = prompt.slice(prompt.indexOf('--- Ticket'));
  if (/services/i.test(question)) {
    const found = ['placement', 'betting', 'relay'].filter((s) => ticket.toLowerCase().includes(s));
    process.stdout.write(found.length ? `${found.join(', ')}\n` : 'NONE\n');
  } else process.stdout.write('NONE\n');
});
