/**
 * Create one remote project. Depends on the port, not on a provider.
 *
 * @param {import('../ports/remote-project.mjs').RemoteProjectPort} port
 * @param {import('../ports/remote-project.mjs').ProjectRequest} request
 * @returns {Promise<import('../ports/remote-project.mjs').RemoteProject>}
 */
export async function createProject(port, request) {
  if (typeof port?.createProject !== 'function') {
    throw new Error('project port is missing createProject');
  }
  const name = request?.name?.trim() ?? '';
  if (!name) throw new Error('name is required');
  const instructions = request?.instructions?.trim() || undefined;
  return port.createProject({ name, instructions });
}
