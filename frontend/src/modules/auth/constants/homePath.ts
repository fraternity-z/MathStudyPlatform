export function getHomePath(role?: string): string {
  return role === 'admin' ? '/admin/dashboard' : '/home';
}
