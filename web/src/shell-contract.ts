// The contract between the nakomis-shell host and its Module Federation remotes.
//
// A remote exposes `./App` whose default export is a React component taking `ShellContext` as props.
// The host shares only `react` and `react-dom` (singletons); each remote bundles its own router and
// UI library, renders its own <BrowserRouter basename={basePath}>, and applies its own theme.
//
// Copy this file into a remote (e.g. src/shell-contract.ts) rather than importing it: it is small,
// changes rarely, and avoids a private package registry. Bump CONTRACT_VERSION on breaking changes.

export const CONTRACT_VERSION = 1;

export type DeployEnv = 'sandbox' | 'prod';

export interface ShellUser {
  /** Cognito `sub`. */
  sub: string;
  username: string;
  email?: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface ShellContext {
  contractVersion: number;
  env: DeployEnv;
  /** Path prefix the remote is mounted at, e.g. "/fleet". Use as the router basename. */
  basePath: string;
  user: ShellUser;
  /** Cognito user pool id of the shared pool, e.g. for identity-pool provider names. */
  userPoolId: string;
  region: string;
  /** Fresh access token (renewed by the shell). For API Gateway JWT authorisers. */
  getAccessToken(): Promise<string>;
  /** Fresh id token. */
  getIdToken(): Promise<string>;
  /** Exchange the id token for AWS credentials from the given identity pool. Cached until near expiry. */
  getAwsCredentials(identityPoolId: string): Promise<AwsCredentials>;
  signOut(): void;
}

/** One entry in /config/remotes.json. */
export interface RemoteDefinition {
  /** Module Federation name, also the URL segment under /remotes/. */
  name: string;
  title: string;
  /** Key into the shell's icon map (see web/src/icons.tsx). */
  icon: string;
  /** Route prefix in the shell, e.g. "/fleet". */
  path: string;
  /** remoteEntry.js URL, usually "/remotes/{name}/remoteEntry.js". */
  entry: string;
  /** Optional external link instead of a remote (for apps that stay standalone). */
  href?: string;
}

/** /config/shell.json, written per env by the shell's CDK stack. */
export interface ShellConfig {
  env: DeployEnv;
  region: string;
  userPoolId: string;
  clientId: string;
  loginDomain: string;
}
