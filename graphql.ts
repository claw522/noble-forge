// graphql.ts — a small GraphQL executor for the GitHub v4 surface the suite speaks:
// viewer, repository reads, issue/pull-request connections with cursor pagination,
// the five mutations gh uses, Relay node(id:) and the __type probes. No dependencies:
// a tokenizer, a parser for the document subset (operations, variables, aliases,
// fragments, input values) and a resolver walk over the shared store.

import { HttpError, VIEWER, type IssueRec, type PullRec, type RepoRec, type Store } from './core.ts';
import { addComment, createIssue, createPull, mergePull, pullFiles, pullMergeable } from './domain.ts';

// ---------------------------------------------------------------- ids

/** Relay global ids: opaque base64 of `Type:innerId`, stable across reads. */
export function globalId(type: string, inner: number | string): string {
  return Buffer.from(`${type}:${inner}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; inner: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return null;
    return { type: text.slice(0, split), inner: text.slice(split + 1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number.parseInt(text.slice(7), 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))!;
      const text = match[0];
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, Value>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value;
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, Value>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error('unsupported definition in document');
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      return { kind: 'fragmentSpread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    const after = this.peek();
    if (after !== undefined && after.kind === 'punct' && after.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'isPrivate',
    'description',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'repository'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Ref: ['name', 'prefix'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- runtime values

type Source =
  | { kind: 'query' }
  | { kind: 'mutation' }
  | { kind: 'user' }
  | { kind: 'repo'; repo: RepoRec }
  | { kind: 'issue'; repo: RepoRec; issue: IssueRec }
  | { kind: 'pull'; repo: RepoRec; pull: PullRec }
  | { kind: 'issueConnection'; repo: RepoRec; nodes: IssueRec[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'pullConnection'; repo: RepoRec; nodes: PullRec[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'ref'; name: string }
  | { kind: 'file'; path: string; additions: number; deletions: number }
  | { kind: 'comment'; id: number; body: string }
  | { kind: 'payload'; field: string; value: Source }
  | { kind: 'commentEdge'; comment: { id: number; body: string } }
  | { kind: 'gqlType'; name: string };

const TYPE_OF_SOURCE: Record<Source['kind'], string> = {
  query: 'Query',
  mutation: 'Mutation',
  user: 'User',
  repo: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  issueConnection: 'IssueConnection',
  pullConnection: 'PullRequestConnection',
  pageInfo: 'PageInfo',
  ref: 'Ref',
  file: 'PullRequestChangedFile',
  comment: 'IssueComment',
  payload: '',
  commentEdge: 'CommentEdge',
  gqlType: '__Type',
};

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

function valueOf(value: Value, ctx: ExecContext, defaults: Map<string, Value>): unknown {
  switch (value.kind) {
    case 'variable': {
      if (value.name in ctx.variables) return ctx.variables[value.name];
      const fallback = defaults.get(value.name);
      return fallback === undefined ? undefined : valueOf(fallback, ctx, defaults);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueOf(entry, ctx, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, ctx, defaults);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: ExecContext, defaults: Map<string, Value>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of node.args) args[arg.name] = valueOf(arg.value, ctx, defaults);
  return args;
}

// ---------------------------------------------------------------- lookups

function findRepoByDatabaseId(store: Store, databaseId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, globalNumericId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.repos.values()) {
    for (const item of repo.items.values()) {
      if (item.kind === 'issue' && item.id === globalNumericId) return { repo, issue: item };
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, globalNumericId: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of store.repos.values()) {
    for (const item of repo.items.values()) {
      if (item.kind === 'pull' && item.id === globalNumericId) return { repo, pull: item };
    }
  }
  return null;
}

// ---------------------------------------------------------------- field resolution

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function connectionPage<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    const index = afterNumber === null ? -1 : items.findIndex((item) => item.number === afterNumber);
    start = index >= 0 ? index + 1 : 0;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : after;
  return { nodes, hasNextPage, endCursor };
}

function resolveField(ctx: ExecContext, source: Source, field: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (source.kind) {
    case 'query': {
      if (field === 'viewer') return { kind: 'user' } satisfies Source;
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = store.getRepo(owner, name);
        return repo === null ? null : ({ kind: 'repo', repo } satisfies Source);
      }
      if (field === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = findRepoByDatabaseId(store, Number(parsed.inner));
          return repo === null ? null : ({ kind: 'repo', repo } satisfies Source);
        }
        if (parsed.type === 'Issue') {
          const found = findIssueByGlobalId(store, Number(parsed.inner));
          return found === null ? null : ({ kind: 'issue', repo: found.repo, issue: found.issue } satisfies Source);
        }
        if (parsed.type === 'PullRequest') {
          const found = findPullByGlobalId(store, Number(parsed.inner));
          return found === null ? null : ({ kind: 'pull', repo: found.repo, pull: found.pull } satisfies Source);
        }
        if (parsed.type === 'User') return { kind: 'user' } satisfies Source;
        return null;
      }
      if (field === '__type') return { kind: 'gqlType', name: String(args.name ?? '') } satisfies Source;
      if (field === '__schema') return { kind: 'gqlType', name: '__schema' } satisfies Source;
      break;
    }
    case 'mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoByDatabaseId(store, Number(parsed.inner)) : null;
        if (repo === null) throw new HttpError(404, 'repository not found for createIssue');
        const issue = createIssue(store, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
        return { kind: 'payload', field: 'issue', value: { kind: 'issue', repo, issue } } satisfies Source;
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        const found = parsed !== null && parsed.type === 'Issue' ? findIssueByGlobalId(store, Number(parsed.inner)) : null;
        if (found === null) throw new HttpError(404, 'issue not found for closeIssue');
        found.issue.state = 'closed';
        return { kind: 'payload', field: 'issue', value: { kind: 'issue', repo: found.repo, issue: found.issue } } satisfies Source;
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoByDatabaseId(store, Number(parsed.inner)) : null;
        if (repo === null) throw new HttpError(404, 'repository not found for createPullRequest');
        const pull = createPull(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        return { kind: 'payload', field: 'pullRequest', value: { kind: 'pull', repo, pull } } satisfies Source;
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        const found = parsed !== null && parsed.type === 'PullRequest' ? findPullByGlobalId(store, Number(parsed.inner)) : null;
        if (found === null) throw new HttpError(404, 'pull request not found for mergePullRequest');
        mergePull(store, found.repo, found.pull, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
        return { kind: 'payload', field: 'pullRequest', value: { kind: 'pull', repo: found.repo, pull: found.pull } } satisfies Source;
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        const found = parsed !== null && parsed.type === 'Issue' ? findIssueByGlobalId(store, Number(parsed.inner)) : null;
        if (found === null) throw new HttpError(404, 'subject not found for addComment');
        const comment = addComment(store, found.repo, found.issue.number, String(input.body ?? ''));
        return { kind: 'payload', field: 'commentEdge', value: { kind: 'commentEdge', comment } } satisfies Source;
      }
      break;
    }
    case 'user': {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return globalId('User', VIEWER.id);
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      break;
    }
    case 'repo': {
      const repo = source.repo;
      switch (field) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { kind: 'user' } satisfies Source;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ kind: 'ref', name: repo.defaultBranch } satisfies Source);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'issue': {
          const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
          return item !== undefined && item.kind === 'issue' ? ({ kind: 'issue', repo, issue: item } satisfies Source) : null;
        }
        case 'issues': {
          let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const descending = orderBy.direction === 'DESC';
          issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          const page = connectionPage(issues, args);
          return { kind: 'issueConnection', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor } satisfies Source;
        }
        case 'pullRequest': {
          const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
          return item !== undefined && item.kind === 'pull' ? ({ kind: 'pull', repo, pull: item } satisfies Source) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states !== null) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
          pulls.sort((a, b) => a.number - b.number);
          const page = connectionPage(pulls, args);
          return { kind: 'pullConnection', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor } satisfies Source;
        }
      }
      break;
    }
    case 'issue': {
      const issue = source.issue;
      switch (field) {
        case 'id':
          return globalId('Issue', issue.id);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'repository':
          return { kind: 'repo', repo: source.repo } satisfies Source;
      }
      break;
    }
    case 'pull': {
      const pull = source.pull;
      switch (field) {
        case 'id':
          return globalId('PullRequest', pull.id);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.state === 'open' ? (pullMergeable(store, source.repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const changes = pullFiles(store, source.repo, pull);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
          return {
            kind: 'pullConnection',
            repo: source.repo,
            nodes: [],
            hasNextPage: false,
            endCursor: null,
            files: changes.slice(0, first).map((change) => ({ path: change.path, additions: change.status === 'removed' ? 0 : 1, deletions: change.status === 'added' ? 0 : 1 })),
          } as unknown as Source;
        }
        case 'repository':
          return { kind: 'repo', repo: source.repo } satisfies Source;
      }
      break;
    }
    case 'issueConnection': {
      if (field === 'nodes') return source.nodes.map((issue) => ({ kind: 'issue', repo: source.repo, issue }) satisfies Source);
      if (field === 'pageInfo') return { kind: 'pageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor } satisfies Source;
      if (field === 'totalCount') return source.nodes.length;
      break;
    }
    case 'pullConnection': {
      const withFiles = source as unknown as { files?: Array<{ path: string; additions: number; deletions: number }> };
      if (field === 'nodes') {
        if (withFiles.files !== undefined) {
          return withFiles.files.map((file) => ({ kind: 'file', path: file.path, additions: file.additions, deletions: file.deletions }) satisfies Source);
        }
        return source.nodes.map((pull) => ({ kind: 'pull', repo: source.repo, pull }) satisfies Source);
      }
      if (field === 'pageInfo') return { kind: 'pageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor } satisfies Source;
      if (field === 'totalCount') return source.nodes.length;
      break;
    }
    case 'pageInfo': {
      if (field === 'hasNextPage') return source.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return source.endCursor;
      if (field === 'startCursor') return source.endCursor;
      break;
    }
    case 'ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'file': {
      if (field === 'path') return source.path;
      if (field === 'additions') return source.additions;
      if (field === 'deletions') return source.deletions;
      break;
    }
    case 'comment': {
      if (field === 'id') return globalId('IssueComment', source.id);
      if (field === 'body') return source.body;
      break;
    }
    case 'payload': {
      if (field === source.field) return source.value;
      break;
    }
    case 'commentEdge': {
      if (field === 'node') return { kind: 'comment', id: source.comment.id, body: source.comment.body } satisfies Source;
      break;
    }
    case 'gqlType': {
      if (field === 'name') return source.name === '__schema' ? null : source.name;
      if (field === 'kind') return TYPE_ENUMS[source.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') return (TYPE_FIELDS[source.name] ?? []).map((name) => ({ kind: 'gqlField', name }) as unknown as Source);
      if (field === 'enumValues') return (TYPE_ENUMS[source.name] ?? []).map((name) => ({ kind: 'gqlEnumValue', name }) as unknown as Source);
      break;
    }
  }
  // __Field / __EnumValue pseudo-sources and any unlisted field land here.
  const pseudo = source as unknown as { kind: string; name?: string };
  if (pseudo.kind === 'gqlField' || pseudo.kind === 'gqlEnumValue') {
    if (field === 'name') return pseudo.name ?? null;
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'deprecationReason') return null;
  }
  return undefined;
}

const PAYLOAD_TYPE: Record<string, string> = {
  issue: 'CreateIssuePayload',
  pullRequest: 'CreatePullRequestPayload',
  commentEdge: 'AddCommentPayload',
};

function typeNameOf(source: Source): string {
  if (source.kind === 'payload') return PAYLOAD_TYPE[source.field] ?? 'CreateIssuePayload';
  if (source.kind === 'gqlType') return '__Type';
  const pseudo = source as unknown as { kind: string };
  if (pseudo.kind === 'gqlField') return '__Field';
  if (pseudo.kind === 'gqlEnumValue') return '__EnumValue';
  return TYPE_OF_SOURCE[source.kind];
}

function knownField(typeName: string, field: string): boolean {
  if (field === '__type' || field === '__schema' || field === '__typename') return true;
  if (typeName === '__Type') return ['name', 'kind', 'fields', 'enumValues', 'description'].includes(field);
  if (typeName === '__Field' || typeName === '__EnumValue') return ['name', 'description', 'isDeprecated', 'deprecationReason'].includes(field);
  return (TYPE_FIELDS[typeName] ?? []).includes(field);
}

function executeSelectionSet(ctx: ExecContext, source: Source, selections: SelectionNode[], defaults: Map<string, Value>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(source);
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== null && fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, source, fragment.selectionSet, defaults));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, source, selection.selectionSet, defaults));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!knownField(typeName, selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, source, selection.name, argsOf(selection, ctx, defaults));
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection, defaults);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, selection: FieldNode, defaults: Map<string, Value>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection, defaults));
  if (typeof value === 'object') {
    if (selection.selectionSet === null) return value;
    return executeSelectionSet(ctx, value as Source, selection.selectionSet, defaults);
  }
  return value;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOperation(store: Store, document: DocumentNode, operationName: string | null, variables: Record<string, unknown>): Record<string, unknown> {
  const operation =
    document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const root: Source = operation.operation === 'mutation' ? { kind: 'mutation' } : { kind: 'query' };
  const data = executeSelectionSet(ctx, root, operation.selectionSet, operation.variableDefaults);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(store: Store, rawText: string): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'request body is not JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { errors: [{ message: 'operation is not an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    try {
      const document = new Parser(tokenize(query)).parseDocument();
      return executeOperation(store, document, operationName, variables);
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
