import { request, type Dispatcher } from 'undici';

export interface FlyApiConfig {
  token: string;
  apiBase?: string; // default https://api.machines.dev/v1
  graphqlBase?: string; // default https://api.fly.io/graphql
}

export interface FlyFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; text(): Promise<string> }>;
}

const defaultFetch: FlyFetch = async (url, init) => {
  const res = await request(url, {
    method: init.method as Dispatcher.HttpMethod,
    headers: init.headers,
    body: init.body,
  });
  return { status: res.statusCode, text: () => res.body.text() };
};

const ALLOCATE_IP_MUTATION = `mutation($input: AllocateIPAddressInput!) {
  allocateIpAddress(input: $input) { ipAddress { address type } }
}`;

/** Thin, injectable client for the Fly Machines REST API + the one GraphQL call it needs
 *  (IP allocation). Request shapes are pinned by the M2a spike findings doc. */
export class FlyApi {
  private readonly apiBase: string;
  private readonly graphqlBase: string;

  constructor(
    private readonly cfg: FlyApiConfig,
    private readonly fetchImpl: FlyFetch = defaultFetch,
  ) {
    this.apiBase = cfg.apiBase ?? 'https://api.machines.dev/v1';
    this.graphqlBase = cfg.graphqlBase ?? 'https://api.fly.io/graphql';
  }

  async createApp(name: string, org: string): Promise<void> {
    await this.rest('POST', `${this.apiBase}/apps`, { app_name: name, org_slug: org });
  }

  /** Both mutations are required: shared_v4 returns `ipAddress: null` on success (shared
   *  IPs aren't dedicated-IP nodes) - only a GraphQL `errors` array means failure. */
  async allocateIps(app: string): Promise<void> {
    await this.graphql(ALLOCATE_IP_MUTATION, { input: { appId: app, type: 'shared_v4' } });
    await this.graphql(ALLOCATE_IP_MUTATION, { input: { appId: app, type: 'v6' } });
  }

  async createVolume(app: string, name: string, region: string, sizeGb: number): Promise<{ id: string }> {
    const method = 'POST';
    const url = `${this.apiBase}/apps/${app}/volumes`;
    const data = (await this.rest(method, url, { name, size_gb: sizeGb, region })) as { id?: string } | undefined;
    if (!data?.id) {
      throw new Error(`fly api ${method} ${url} → missing id in response`);
    }
    return { id: data.id };
  }

  async createMachine(app: string, region: string, config: Record<string, unknown>): Promise<{ id: string }> {
    const method = 'POST';
    const url = `${this.apiBase}/apps/${app}/machines`;
    const data = (await this.rest(method, url, { region, config })) as { id?: string } | undefined;
    if (!data?.id) {
      throw new Error(`fly api ${method} ${url} → missing id in response`);
    }
    return { id: data.id };
  }

  async waitStarted(app: string, machineId: string): Promise<void> {
    await this.rest('GET', `${this.apiBase}/apps/${app}/machines/${machineId}/wait?state=started&timeout=60`);
  }

  async destroyApp(app: string): Promise<void> {
    await this.rest('DELETE', `${this.apiBase}/apps/${app}?force=true`);
  }

  private async rest(method: string, url: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`fly api ${method} ${url} → ${res.status}`);
    }
    // Fly's Machines API can return a 2xx with an empty body (e.g. DELETE .../apps/{app}
    // responds 202 with nothing) - JSON.parse('') throws, so treat empty/whitespace as no body.
    const text = await res.text();
    if (text.trim() === '') {
      return undefined;
    }
    return JSON.parse(text);
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const url = this.graphqlBase;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`fly api POST ${url} → ${res.status}`);
    }
    const data = JSON.parse(await res.text()) as { errors?: Array<{ message: string }> };
    if (data.errors && data.errors.length > 0) {
      throw new Error(`fly graphql error: ${data.errors[0].message}`);
    }
    return data;
  }
}
