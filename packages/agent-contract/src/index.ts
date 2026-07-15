export const TUNNEL_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
export const TUNNEL_NAME_REGEX = new RegExp(`^${TUNNEL_NAME_PATTERN}$`);
