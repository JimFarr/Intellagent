'use strict';
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 James Farrugia
/* ado: the Azure DevOps REST calls the Deployments page needs (API 7.1), as one PAT. Ported from KM.Launchpad's
   AdoService (MIT): who the PAT is, projects, pipelines and what a pipeline takes (its YAML parameters, overridable
   variables, branches, pipeline resources), and triggering and reading runs. The PAT stays in this closure: no
   method returns it, and no error message carries it. */
const { pipelineDeclarations, resolveRepoPath } = require('./yaml.ts');

type Json = any;
type Run = {
  id: number; pipelineId: number; buildNumber: string | null; state: string; result: string | null; branch: string | null;
  requestedFor: string | null; queueTime: string | null; startTime: string | null; finishTime: string | null; webUrl: string;
  tags: string[]; pipelineName: string | null; reason: string | null;
};
type Branch = { name: string; isDefault: boolean; mine: boolean; lastCommit: string | null };
type Trigger = { branch: string; templateParameters?: Record<string, string>; variables?: Record<string, string>; pipelineResources?: Record<string, string>; containerResources?: Record<string, string> };

const API = '7.1';
const TAG = '🚀 intellagent'; // every run the board starts carries it, so they are easy to find in Azure DevOps
class AdoError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// deps: { org, pat, baseUrl? (Azure DevOps Server, or a test stand-in), fetch?, timeoutMs? }
function createAdo({ org, pat, baseUrl, fetch = globalThis.fetch, timeoutMs = 30000 }: { org: string; pat: string; baseUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
  const root = `${(baseUrl || 'https://dev.azure.com').replace(/\/+$/, '')}/${encodeURIComponent(org)}`;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const p = (project: string) => `${root}/${encodeURIComponent(project)}`;

  async function send(method: string, url: string, body?: unknown, text = false): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: auth, accept: text ? 'text/plain' : 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) { throw new AdoError(502, `Azure DevOps could not be reached: ${e?.cause?.code || e?.message || e}`); }
    const content = await res.text();
    // a redirect is the sign-in page: Azure DevOps answers an expired or wrong PAT that way
    if (res.status >= 300 && res.status < 400) throw new AdoError(401, 'Azure DevOps refused the token (expired, revoked or for another organization)');
    if (!res.ok) throw new AdoError(res.status === 401 || res.status === 403 ? res.status : res.status >= 500 ? 502 : res.status, errorText(content, res.status));
    if (text) return content;
    // and sometimes a 200 with that page in HTML
    if (content.trimStart().startsWith('<')) throw new AdoError(401, 'Azure DevOps refused the token (expired, revoked or for another organization)');
    try { return content ? JSON.parse(content) : {}; } catch { throw new AdoError(502, 'Azure DevOps sent something that is not JSON'); }
  }
  function errorText(content: string, status: number): string {
    try { const m = JSON.parse(content)?.message; if (m) return String(m).slice(0, 300); } catch { /* not json */ }
    return status === 404 ? 'Not found in Azure DevOps' : `Azure DevOps answered ${status}`;
  }

  async function whoami() {
    const d = await send('GET', `${root}/_apis/connectionData?api-version=${API}-preview`);
    const u = d?.authenticatedUser || {};
    if (!u.id) throw new AdoError(401, 'Could not tell who this token belongs to');
    return { id: String(u.id), displayName: String(u.providerDisplayName || ''), uniqueName: String(u.properties?.Account?.$value || '') };
  }

  async function projects() {
    const d = await send('GET', `${root}/_apis/projects?api-version=${API}&$top=500&stateFilter=wellFormed`);
    return (d.value || []).map((x: Json) => ({ id: String(x.id), name: String(x.name) })).sort((a: Json, b: Json) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async function pipelines(project: string) {
    const d = await send('GET', `${p(project)}/_apis/build/definitions?api-version=${API}&$top=1000&queryOrder=definitionNameAscending`);
    return (d.value || []).map((x: Json) => ({ id: Number(x.id), name: String(x.name), project, folder: folderOf(x.path), enabled: String(x.queueStatus || 'enabled').toLowerCase() !== 'disabled' }));
  }

  const definition = (project: string, id: number) => send('GET', `${p(project)}/_apis/build/definitions/${Number(id)}?api-version=${API}`);
  const repoFile = async (project: string, repoId: string, file: string, branch: string): Promise<string | null> => {
    try {
      return await send('GET', `${p(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/items?path=${encodeURIComponent(file)}`
        + `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&includeContent=true&$format=text&api-version=${API}`, undefined, true);
    } catch { return null; }
  };

  // Everything the step editor offers for one pipeline. The YAML is read best-effort: a pipeline we can't read
  // still has its variables and branches, and its parameters are then typed by hand.
  async function pipeline(project: string, id: number, uniqueName?: string) {
    const d = await definition(project, id);
    const repo = d.repository || {};
    const defaultBranch = repo.defaultBranch ? String(repo.defaultBranch) : null;
    const info = { id: Number(d.id), name: String(d.name), project, folder: folderOf(d.path), repositoryName: repo.name || null, defaultBranch: shortRef(defaultBranch), enabled: String(d.queueStatus || 'enabled').toLowerCase() !== 'disabled' };
    let parameters: Json[] = [];
    let resources: Json[] = [];
    const yamlFile = d.process?.yamlFilename;
    if (yamlFile && repo.id) {
      const branch = shortRef(defaultBranch) || 'main';
      const text = await repoFile(project, repo.id, yamlFile, branch);
      if (text != null) {
        const top = pipelineDeclarations(text);
        parameters = top.parameters;
        resources = top.resources;
        // no parameters of its own: follow a template in the same repository, one level, as Launchpad does
        const t = top.extendsTemplate;
        if (!parameters.length && t && (!t.includes('@') || t.endsWith('@self'))) {
          const ttext = await repoFile(project, repo.id, resolveRepoPath(yamlFile, t.replace(/@self$/, '')), branch);
          if (ttext != null) {
            const tpl = pipelineDeclarations(ttext);
            parameters = tpl.parameters;
            resources = [...resources, ...tpl.resources.filter((r: Json) => !resources.some((x) => x.alias === r.alias))];
          }
        }
      }
    }
    // overridable variables from the definition; secrets are never offered or prefilled
    for (const [name, v] of Object.entries<Json>(d.variables || {})) {
      if (v?.isSecret) continue;
      parameters.push({ name, kind: 'variable', type: 'string', defaultValue: v?.value ?? null, allowOverride: !!v?.allowOverride, allowedValues: null });
    }
    const branches = repo.id ? await branchesOf(project, String(repo.id), defaultBranch, uniqueName) : [];
    return { pipeline: info, branches, parameters, resources };
  }

  // Branches, the person's own most recent first (from each tip's author), else the plain ref list.
  async function branchesOf(project: string, repoId: string, defaultBranch: string | null, uniqueName?: string): Promise<Branch[]> {
    const def = shortRef(defaultBranch);
    const me = (uniqueName || '').toLowerCase();
    try {
      const d = await send('GET', `${p(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/stats/branches?api-version=${API}`);
      const list: Branch[] = (d.value || []).filter((b: Json) => b.name).map((b: Json) => {
        const a = b.commit?.author || {}, c = b.commit?.committer || {};
        const mine = !!me && [a.email, c.email].some((e) => String(e || '').toLowerCase() === me);
        return { name: String(b.name), isDefault: b.name === def, mine, lastCommit: a.date || c.date || null };
      });
      if (list.length) {
        return list.sort((x, y) => Number(y.mine) - Number(x.mine) || String(y.lastCommit || '').localeCompare(String(x.lastCommit || '')) || Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name));
      }
    } catch (e) { if (!(e instanceof AdoError)) throw e; }
    const d = await send('GET', `${p(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?filter=heads/&api-version=${API}&$top=1000`);
    return (d.value || []).map((r: Json) => shortRef(r.name) || '').filter(Boolean)
      .map((name: string) => ({ name, isDefault: name === def, mine: false, lastCommit: null }))
      .sort((x: Branch, y: Branch) => Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name));
  }

  async function defaultBranch(project: string, id: number): Promise<string | null> {
    return shortRef((await definition(project, id)).repository?.defaultBranch || null);
  }
  // "smart": the person's most recently worked-on branch of the pipeline's repository, else its default branch
  async function recentBranch(project: string, id: number, uniqueName?: string): Promise<string | null> {
    const d = await definition(project, id);
    const repo = d.repository || {};
    const def = shortRef(repo.defaultBranch || null);
    if (!repo.id) return def;
    return (await branchesOf(project, String(repo.id), repo.defaultBranch || null, uniqueName)).find((b) => b.mine)?.name || def;
  }

  // A ticket's branch: of the pipeline's repository, the one whose name holds one of the keys (the ticket id, its Jira
  // key) as a whole word, the person's own and most recent first. BET-12 never matches feature/BET-123.
  async function ticketBranch(project: string, id: number, keys: string[], uniqueName?: string): Promise<string | null> {
    const repo = (await definition(project, id)).repository || {};
    if (!repo.id || !keys.length) return null;
    const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9])(${keys.map(esc).join('|')})(?![0-9])`, 'i');
    return (await branchesOf(project, String(repo.id), repo.defaultBranch || null, uniqueName)).find((b) => re.test(b.name))?.name || null;
  }

  async function runPipeline(project: string, id: number, t: Trigger): Promise<Run> {
    const resources: Json = { repositories: { self: { refName: toRef(t.branch) } } };
    if (t.pipelineResources && Object.keys(t.pipelineResources).length) resources.pipelines = mapValues(t.pipelineResources, (v) => ({ version: v }));
    if (t.containerResources && Object.keys(t.containerResources).length) resources.containers = mapValues(t.containerResources, (v) => ({ version: v }));
    const body: Json = { resources };
    if (t.templateParameters && Object.keys(t.templateParameters).length) body.templateParameters = t.templateParameters;
    if (t.variables && Object.keys(t.variables).length) body.variables = mapValues(t.variables, (v) => ({ value: v, isSecret: false }));
    const d = await send('POST', `${p(project)}/_apis/pipelines/${Number(id)}/runs?api-version=${API}`, body);
    const runId = Number(d.id);
    try { await send('POST', `${p(project)}/_apis/build/builds/${runId}/tags?api-version=${API}`, [TAG]); } catch { /* a tag is a nicety */ }
    return getRun(project, runId); // a pipelines run id is its build id; the build view has more
  }

  async function getRun(project: string, buildId: number): Promise<Run> {
    const b = await send('GET', `${p(project)}/_apis/build/builds/${Number(buildId)}?api-version=${API}`);
    return {
      id: Number(b.id), pipelineId: Number(b.definition?.id || 0), buildNumber: b.buildNumber ?? null,
      state: String(b.status || 'unknown'), result: b.result ?? null, branch: shortRef(b.sourceBranch || null),
      requestedFor: b.requestedFor?.displayName ?? null, queueTime: b.queueTime ?? null, startTime: b.startTime ?? null, finishTime: b.finishTime ?? null,
      webUrl: String(b._links?.web?.href || ''), tags: Array.isArray(b.tags) ? b.tags.filter(Boolean).map(String) : [],
      pipelineName: b.definition?.name ?? null, reason: b.reason ?? null,
    };
  }

  // The newest pull requests of a project, any repository and state (so one raised and completed between two looks
  // is still seen), with the link a person opens
  async function pullRequests(project: string, top = 100) {
    const d = await send('GET', `${p(project)}/_apis/git/pullrequests?searchCriteria.status=all&$top=${Number(top)}&api-version=${API}`);
    return (d.value || []).map((x: Json) => {
      const repo = String(x.repository?.name || '');
      return {
        id: Number(x.pullRequestId), title: String(x.title || ''), status: String(x.status || ''), project, repo,
        source: shortRef(x.sourceRefName || null), target: shortRef(x.targetRefName || null),
        by: x.createdBy?.displayName ?? null, createdAt: x.creationDate ?? null,
        url: `${p(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${Number(x.pullRequestId)}`,
      };
    });
  }

  /* Pull requests, for the PR actions (lib/deploy/pr-actions.ts): one PR by its id (the organization finds its project
     and repository), then a reply on a thread, a thread's status, a new thread, and the token owner's vote. A reply or
     a thread answers the comment ids it made, so the webhook can tell the board's own comments from people's. */
  async function pullRequest(id: number) {
    const x = await send('GET', `${root}/_apis/git/pullrequests/${Number(id)}?api-version=${API}`);
    const repo = String(x.repository?.name || ''), project = String(x.repository?.project?.name || '');
    return {
      id: Number(x.pullRequestId), title: String(x.title || ''), status: String(x.status || ''), project, repo, repoId: String(x.repository?.id || ''),
      source: shortRef(x.sourceRefName || null), target: shortRef(x.targetRefName || null), by: x.createdBy?.displayName ?? null,
      url: `${p(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${Number(x.pullRequestId)}`,
    };
  }
  const prPath = (pr: Json) => `${p(pr.project)}/_apis/git/repositories/${encodeURIComponent(pr.repoId)}/pullRequests/${Number(pr.id)}`;
  async function prReply(pr: Json, threadId: number, content: string) {
    const c = await send('POST', `${prPath(pr)}/threads/${Number(threadId)}/comments?api-version=${API}`, { parentCommentId: 1, content, commentType: 1 });
    return { threadId: Number(threadId), commentId: Number(c.id) };
  }
  // status: active | fixed | wontFix | closed | byDesign | pending
  const prThreadStatus = (pr: Json, threadId: number, status: string) => send('PATCH', `${prPath(pr)}/threads/${Number(threadId)}?api-version=${API}`, { status });
  async function prComment(pr: Json, content: string) {
    const t = await send('POST', `${prPath(pr)}/threads?api-version=${API}`, { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 'active' });
    return { threadId: Number(t.id), commentId: Number(t.comments?.[0]?.id || 1) };
  }
  // vote 10 approves; the reviewer is the token's owner (whoami().id)
  const prVote = (pr: Json, reviewerId: string, vote = 10) => send('PUT', `${prPath(pr)}/reviewers/${encodeURIComponent(reviewerId)}?api-version=${API}`, { vote });

  return { org, whoami, projects, pipelines, pipeline, defaultBranch, recentBranch, ticketBranch, runPipeline, getRun, pullRequests, pullRequest, prReply, prThreadStatus, prComment, prVote };
}

const shortRef = (r: string | null): string | null => (r ? r.replace(/^refs\/heads\//, '') : null);
const toRef = (b: string) => (b.startsWith('refs/') ? b : `refs/heads/${b}`);
const folderOf = (path: unknown): string | null => { const s = String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); return s || null; };
const mapValues = (o: Record<string, string>, f: (v: string) => unknown) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

module.exports = { createAdo, AdoError, TAG };
