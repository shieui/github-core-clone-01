// graphql.ts — GitHub GraphQL v4 at POST /api/graphql: a hand-rolled parser and
// executor over the store (no library). Supports the documents the suite sends:
// operations with names and variables, aliases, inline fragments, inline input
// objects and enum lists, null variables, and batched arrays of operations.
//
// Error contract: a GraphQL-level failure (unknown field, bad input) is HTTP 200
// with an `errors` array; the field that failed resolves to null. An unknown repo
// is data.repository = null with no errors.

import {
  DEFAULT_BRANCH,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selection?: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Map<string, { default?: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
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
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', variables: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selection });
        continue;
      }
      if (token.kind === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
        this.next();
        const kind = token.value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, { default?: ValueNode }> {
    const variables = new Map<string, { default?: ValueNode }>();
    const token = this.peek();
    if (!token || token.kind !== 'punct' || token.value !== '(') return variables;
    this.next();
    while (true) {
      const next = this.peek();
      if (!next) throw new Error('unterminated variable definitions');
      if (next.kind === 'punct' && next.value === ')') {
        this.next();
        return variables;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      const eq = this.peek();
      let def: { default?: ValueNode } = {};
      if (eq?.kind === 'punct' && eq.value === '=') {
        this.next();
        def = { default: this.parseValue() };
      }
      this.skipDirectives();
      variables.set(name, def);
    }
  }

  private parseType(): void {
    const token = this.peek();
    if (!token) throw new Error('unterminated type');
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang?.kind === 'punct' && bang.value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      const open = this.peek();
      if (open?.kind === 'punct' && open.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
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
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const brace = this.peek();
    let selection: SelectionNode[] | undefined;
    if (brace?.kind === 'punct' && brace.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    const token = this.peek();
    if (!token || token.kind !== 'punct' || token.value !== '(') return args;
    this.next();
    while (true) {
      const next = this.peek();
      if (!next) throw new Error('unterminated arguments');
      if (next.kind === 'punct' && next.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated list value');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (true) {
        const next = this.peek();
        if (!next) throw new Error('unterminated object value');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// schema (for __type introspection)
// ---------------------------------------------------------------------------

const SCHEMA_TYPES: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search'],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
      'defaultBranch', 'url', 'createdAt', 'updatedAt',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'repository'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommitSha', 'headRefName',
      'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'author', 'repository',
    ],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MILESTONE'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
};

// ---------------------------------------------------------------------------
// runtime values
// ---------------------------------------------------------------------------

type RuntimeValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; items: RuntimeValue[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: RuntimeValue[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestFileConnection'; repo: Repo; pull: Pull; items: RuntimeValue[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestFile'; path: string }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue; items: RuntimeValue[]; pageInfo: PageInfoValue }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'IssueCommentEdge'; node: RuntimeValue }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'Query' }
  | { __typename: 'Mutation' };

interface PageInfoValue {
  hasNextPage: boolean;
  endCursor: string | null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: GraphQLError[];
  document: DocumentNode;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of node.fields) out[key] = valueOf(child, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const node = field.args.get(name);
  if (!node) return undefined;
  return valueOf(node, ctx.variables);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = store.mergeBase(repo, headTip, baseTip);
  return store.hasConflict(repo, base, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function issueConnection(repo: Repo, issues: Issue[], first: number | undefined, after: string | null | undefined): { __typename: 'IssueConnection'; repo: Repo; items: RuntimeValue[]; pageInfo: PageInfoValue } {
  const afterNumber = numberFromCursor(typeof after === 'string' ? after : null);
  let start = 0;
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    start = index >= 0 ? index + 1 : 0;
  }
  const limit = first ?? issues.length;
  const page = issues.slice(start, start + limit);
  const hasNextPage = start + page.length < issues.length;
  return {
    __typename: 'IssueConnection',
    repo,
    items: page.map((issue) => ({ __typename: 'Issue', repo, issue }) as RuntimeValue),
    pageInfo: {
      hasNextPage,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

/** Resolve one field of a runtime value; returns the raw value (scalar, array or RuntimeValue). */
function resolveField(
  parent: RuntimeValue,
  field: FieldNode,
  ctx: ExecContext,
): unknown {
  const store = ctx.store;
  const name = field.name;
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: VIEWER.login };
      if (name === 'repository') {
        const owner = argValue(field, 'owner', ctx);
        const repoName = argValue(field, 'name', ctx);
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, repoName);
        return repo ? { __typename: 'Repository', repo } : null;
      }
      if (name === 'node') {
        const id = argValue(field, 'id', ctx);
        if (typeof id !== 'string') return null;
        const resolved = store.resolveGlobalId(id);
        if (!resolved) return null;
        if (resolved.kind === 'repo') {
          const repo = store.getRepo(...(resolved.key.split('/') as [string, string]));
          return repo ? { __typename: 'Repository', repo } : null;
        }
        if (resolved.kind === 'issue') {
          const [fullName, num] = resolved.key.split('#');
          const [owner, repoName] = fullName!.split('/');
          const repo = store.getRepo(owner!, repoName!);
          const issue = repo?.issues.find((entry) => entry.number === parseInt(num!, 10));
          return repo && issue ? { __typename: 'Issue', repo, issue } : null;
        }
        if (resolved.kind === 'pull') {
          const [fullName, num] = resolved.key.split('#');
          const [owner, repoName] = fullName!.split('/');
          const repo = store.getRepo(owner!, repoName!);
          const pull = repo?.pulls.find((entry) => entry.number === parseInt(num!, 10));
          return repo && pull ? { __typename: 'PullRequest', repo, pull } : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argValue(field, 'name', ctx);
        if (typeof typeName !== 'string') return null;
        return SCHEMA_TYPES[typeName] ? { __typename: '__Type', name: typeName } : null;
      }
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const repositoryId = input.repositoryId;
        const title = input.title;
        if (typeof repositoryId !== 'string' || typeof title !== 'string') {
          ctx.errors.push({ message: 'createIssue needs repositoryId and title' });
          return null;
        }
        const resolved = store.resolveGlobalId(repositoryId);
        if (!resolved || resolved.kind !== 'repo') {
          ctx.errors.push({ message: `createIssue: unknown repositoryId ${repositoryId}` });
          return null;
        }
        const [owner, repoName] = resolved.key.split('/');
        const repo = store.getRepo(owner!, repoName!);
        if (!repo) {
          ctx.errors.push({ message: `createIssue: unknown repository ${resolved.key}` });
          return null;
        }
        const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue, repo } as unknown as RuntimeValue;
      }
      if (name === 'closeIssue') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const issueId = input.issueId;
        if (typeof issueId !== 'string') {
          ctx.errors.push({ message: 'closeIssue needs issueId' });
          return null;
        }
        const resolved = store.resolveGlobalId(issueId);
        if (!resolved || resolved.kind !== 'issue') {
          ctx.errors.push({ message: `closeIssue: unknown issueId ${issueId}` });
          return null;
        }
        const [fullName, num] = resolved.key.split('#');
        const [owner, repoName] = fullName!.split('/');
        const repo = store.getRepo(owner!, repoName!);
        const issue = repo?.issues.find((entry) => entry.number === parseInt(num!, 10));
        if (!repo || !issue) {
          ctx.errors.push({ message: `closeIssue: unknown issue ${issueId}` });
          return null;
        }
        issue.state = 'closed';
        repo.version += 1;
        return { __typename: 'CloseIssuePayload', issue, repo } as unknown as RuntimeValue;
      }
      if (name === 'createPullRequest') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const repositoryId = input.repositoryId;
        const headRefName = input.headRefName;
        const baseRefName = input.baseRefName;
        const title = input.title;
        if (typeof repositoryId !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
          ctx.errors.push({ message: 'createPullRequest needs repositoryId, headRefName, baseRefName and title' });
          return null;
        }
        const resolved = store.resolveGlobalId(repositoryId);
        if (!resolved || resolved.kind !== 'repo') {
          ctx.errors.push({ message: `createPullRequest: unknown repositoryId ${repositoryId}` });
          return null;
        }
        const [owner, repoName] = resolved.key.split('/');
        const repo = store.getRepo(owner!, repoName!);
        if (!repo) {
          ctx.errors.push({ message: `createPullRequest: unknown repository ${resolved.key}` });
          return null;
        }
        const headSha = repo.refs.get(`refs/heads/${headRefName}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: `createPullRequest: head or base branch does not exist` });
          return null;
        }
        const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
        return { __typename: 'CreatePullRequestPayload', pull, repo } as unknown as RuntimeValue;
      }
      if (name === 'mergePullRequest') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const pullRequestId = input.pullRequestId;
        if (typeof pullRequestId !== 'string') {
          ctx.errors.push({ message: 'mergePullRequest needs pullRequestId' });
          return null;
        }
        const resolved = store.resolveGlobalId(pullRequestId);
        if (!resolved || resolved.kind !== 'pull') {
          ctx.errors.push({ message: `mergePullRequest: unknown pullRequestId ${pullRequestId}` });
          return null;
        }
        const [fullName, num] = resolved.key.split('#');
        const [owner, repoName] = fullName!.split('/');
        const repo = store.getRepo(owner!, repoName!);
        const pull = repo?.pulls.find((entry) => entry.number === parseInt(num!, 10));
        if (!repo || !pull) {
          ctx.errors.push({ message: `mergePullRequest: unknown pull request ${pullRequestId}` });
          return null;
        }
        if (pull.state === 'closed') {
          ctx.errors.push({ message: `mergePullRequest: pull request ${pull.number} is already closed` });
          return null;
        }
        const merged = store.squashMerge(repo, pull);
        if (!merged.ok) {
          ctx.errors.push({ message: `mergePullRequest: ${merged.reason}` });
          return null;
        }
        return { __typename: 'MergePullRequestPayload', pull, repo } as unknown as RuntimeValue;
      }
      if (name === 'addComment') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const subjectId = input.subjectId;
        const body = input.body;
        if (typeof subjectId !== 'string' || typeof body !== 'string') {
          ctx.errors.push({ message: 'addComment needs subjectId and body' });
          return null;
        }
        const resolved = store.resolveGlobalId(subjectId);
        if (!resolved || resolved.kind !== 'issue') {
          ctx.errors.push({ message: `addComment: unknown subjectId ${subjectId}` });
          return null;
        }
        const [fullName, num] = resolved.key.split('#');
        const [owner, repoName] = fullName!.split('/');
        const repo = store.getRepo(owner!, repoName!);
        const issue = repo?.issues.find((entry) => entry.number === parseInt(num!, 10));
        if (!repo || !issue) {
          ctx.errors.push({ message: `addComment: unknown subject ${subjectId}` });
          return null;
        }
        const comment = { id: store.nextCommentId(), body };
        issue.comments.push(comment);
        repo.version += 1;
        return { __typename: 'AddCommentPayload', repo, issue, comment } as unknown as RuntimeValue;
      }
      return undefined;
    }
    case 'User': {
      if (name === 'login') return parent.login;
      if (name === 'id') return store.globalId('User', parent.login);
      if (name === 'name') return parent.login === VIEWER.login ? VIEWER.name : parent.login;
      if (name === 'email') return parent.login === VIEWER.login ? VIEWER.email : '';
      if (name === 'url') return `https://github.com/${parent.login}`;
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo;
      if (name === 'id') return store.globalId('Repository', repo.fullName);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return repo.fullName;
      if (name === 'owner') return { __typename: 'User', login: repo.owner };
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'private') return repo.private;
      if (name === 'defaultBranch') return repo.defaultBranch;
      if (name === 'url') return `https://github.com/${repo.fullName}`;
      if (name === 'issue') {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue ? { __typename: 'Issue', repo, issue } : null;
      }
      if (name === 'issues') {
        const first = argValue(field, 'first', ctx);
        const after = argValue(field, 'after', ctx);
        const states = argValue(field, 'states', ctx);
        const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC') {
          list.sort((a, b) => b.number - a.number);
        } else if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'ASC') {
          list.sort((a, b) => a.number - b.number);
        } else {
          list.sort((a, b) => a.number - b.number);
        }
        return issueConnection(
          repo,
          list,
          typeof first === 'number' ? first : undefined,
          typeof after === 'string' ? after : null,
        );
      }
      if (name === 'pullRequests') {
        const first = argValue(field, 'first', ctx);
        const after = argValue(field, 'after', ctx);
        const states = argValue(field, 'states', ctx);
        let list = [...repo.pulls].sort((a, b) => b.number - a.number);
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          list = list.filter((pull) => wanted.has(pullState(pull)));
        }
        const afterNumber = numberFromCursor(typeof after === 'string' ? after : null);
        let start = 0;
        if (afterNumber !== null) {
          const index = list.findIndex((pull) => pull.number === afterNumber);
          start = index >= 0 ? index + 1 : 0;
        }
        const limit = typeof first === 'number' ? first : list.length;
        const page = list.slice(start, start + limit);
        return {
          __typename: 'PullRequestConnection',
          repo,
          items: page.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as RuntimeValue),
          pageInfo: {
            hasNextPage: start + page.length < list.length,
            endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
          },
        };
      }
      if (name === 'pullRequest') {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull ? { __typename: 'PullRequest', repo, pull } : null;
      }
      return undefined;
    }
    case 'Issue': {
      const { issue, repo } = parent;
      if (name === 'id') return store.globalId('Issue', `${repo.fullName}#${issue.number}`);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueState(issue);
      if (name === 'body') return issue.body;
      if (name === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      if (name === 'repository') return { __typename: 'Repository', repo };
      if (name === 'author') return { __typename: 'User', login: VIEWER.login };
      if (name === 'labels') return issue.labels.map((label) => ({ __typename: 'Label', name: label.name }));
      if (name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          repo,
          issue,
          items: issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment }) as RuntimeValue),
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      }
      return undefined;
    }
    case 'PullRequest': {
      const { pull, repo } = parent;
      if (name === 'id') return store.globalId('PullRequest', `${repo.fullName}#${pull.number}`);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergedAt') return pull.merged ? pull.mergedAt : null;
      if (name === 'mergeCommitSha') return pull.merged ? pull.mergeCommitSha : null;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return mergeableOf(store, repo, pull);
      if (name === 'url') return `https://github.com/${repo.fullName}/pull/${pull.number}`;
      if (name === 'repository') return { __typename: 'Repository', repo };
      if (name === 'author') return { __typename: 'User', login: VIEWER.login };
      if (name === 'files') {
        const first = argValue(field, 'first', ctx);
        const baseOid = store.mergeBase(repo, pull.head.sha, pull.base.sha);
        const files = store.diffFiles(repo, baseOid ?? '0'.repeat(40), pull.head.sha);
        const limit = typeof first === 'number' ? first : files.length;
        return {
          __typename: 'PullRequestFileConnection',
          repo,
          pull,
          items: files.slice(0, limit).map((file) => ({ __typename: 'PullRequestFile', path: file.filename }) as RuntimeValue),
          pageInfo: { hasNextPage: files.length > limit, endCursor: null },
        };
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'IssueCommentConnection': {
      if (name === 'nodes') return parent.items;
      if (name === 'edges') {
        return parent.items.map((item) => ({ node: item }));
      }
      if (name === 'pageInfo') return { __typename: 'PageInfo', ...parent.pageInfo };
      if (name === 'totalCount') return parent.items.length;
      return undefined;
    }
    case 'PullRequestFile': {
      if (name === 'path') return parent.path;
      if (name === 'filename') return parent.path;
      return undefined;
    }
    case '__Field': {
      if (name === 'name') return parent.name;
      return undefined;
    }
    case '__EnumValue': {
      if (name === 'name') return parent.name;
      return undefined;
    }
    case 'Ref': {
      if (name === 'name') return parent.name;
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return parent.endCursor;
      if (name === 'startCursor') return null;
      return undefined;
    }
    case 'IssueComment': {
      if (name === 'id') return store.globalId('IssueComment', `${parent.repo.fullName}#${parent.issue.number}#${parent.comment.id}`);
      if (name === 'body') return parent.comment.body;
      if (name === 'author') return { __typename: 'User', login: VIEWER.login };
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return parent.node;
      if (name === 'cursor') return '';
      return undefined;
    }
    case '__Type': {
      const type = SCHEMA_TYPES[parent.name];
      if (!type) return null;
      if (name === 'name') return parent.name;
      if (name === 'kind') return type.kind;
      if (name === 'fields') {
        if (type.kind !== 'OBJECT') return null;
        return (type.fields ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
      }
      if (name === 'enumValues') {
        if (type.kind !== 'ENUM') return null;
        return (type.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
      }
      return undefined;
    }
    default: {
      // Mutation payloads.
      const payload = parent as unknown as Record<string, unknown>;
      if (name === 'issue' && payload.issue) {
        const issue = payload.issue as Issue;
        const repo = payload.repo as Repo;
        return { __typename: 'Issue', repo, issue };
      }
      if (name === 'pullRequest' && payload.pull) {
        const pull = payload.pull as Pull;
        const repo = payload.repo as Repo;
        return { __typename: 'PullRequest', repo, pull };
      }
      if (name === 'commentEdge' && payload.comment) {
        const comment = payload.comment as { id: number; body: string };
        const repo = payload.repo as Repo;
        const issue = payload.issue as Issue;
        return {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo, issue, comment },
        };
      }
      return undefined;
    }
  }
}

/** The GraphQL type name of a runtime value (for inline-fragment matching). */
function typenameOf(value: RuntimeValue): string {
  return value.__typename;
}

function executeSelectionSet(
  parent: RuntimeValue,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      const nested = executeSelectionSet(parent, fragment.selection, ctx, path);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typenameOf(parent)) continue;
      const nested = executeSelectionSet(parent, selection.selection, ctx, path);
      Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    const resolved = resolveField(parent, field, ctx);
    if (resolved === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${typenameOf(parent)}".`,
        path: fieldPath,
      });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(resolved, field, ctx, fieldPath);
  }
  return out;
}

/** Complete a resolved value against the field's sub-selections (or return the scalar). */
function completeValue(
  value: unknown,
  field: FieldNode,
  ctx: ExecContext,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, field, ctx, [...path, index]));
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const runtime = value as RuntimeValue;
    // A connection's `nodes` items are plain objects (issues/pulls) or path objects:
    // wrap them so nested selections resolve.
    return executeSelectionSet(runtime, field.selection, ctx, path);
  }
  if (typeof value === 'object') {
    // Plain objects (e.g. __Field {name}, __EnumValue {name}, Edge {node}): resolve
    // their scalar fields directly, and recurse for nested runtime values.
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const selection of field.selection) {
      if (selection.kind !== 'field') continue;
      const responseKey = selection.alias ?? selection.name;
      const child = record[selection.name];
      if (child === undefined) {
        ctx.errors.push({
          message: `Cannot query field "${selection.name}" on type "${(record.__typename as string) ?? 'Object'}".`,
          path: [...path, responseKey],
        });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = completeValue(child, selection, ctx, [...path, responseKey]);
    }
    return out;
  }
  return value;
}

/** Execute one operation document. Returns the response body. */
export function executeOperation(
  store: Store,
  documentText: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): { data: Record<string, unknown> | null; errors: GraphQLError[] } {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(documentText)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document has no operation' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName) {
    operation = document.operations.find((entry) => entry.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    return { data: null, errors: [{ message: 'GraphQL document has multiple operations; pass operationName.' }] };
  }
  const ctx: ExecContext = { store, variables: { ...variables }, errors: [], document };
  // Apply variable defaults.
  for (const [name, def] of operation.variables) {
    if (ctx.variables[name] === undefined && def.default !== undefined) {
      ctx.variables[name] = valueOf(def.default, ctx.variables);
    }
  }
  const root: RuntimeValue = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelectionSet(root, operation.selection, ctx, []);
  return { data, errors: ctx.errors };
}

/** Handle a POST /api/graphql body (object or array). Returns the response body. */
export function handleGraphQL(store: Store, bodyText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { data: null, errors: [{ message: 'GraphQL request body is not valid JSON' }] };
  }
  const run = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL operation must be an object with query' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL operation needs a query string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeOperation(store, query, variables, operationName);
  };
  if (Array.isArray(parsed)) return parsed.map(run);
  return run(parsed);
}

export { DEFAULT_BRANCH };
