import { WS_TOKEN_EXPIRY_TIME } from "@/utils/const.ts";

type UserSealosKubeconfigBinding = {
  kubeconfig: string;
  updatedAt: number;
};

const userSealosKubeconfigMap = new Map<
  number,
  Map<string, UserSealosKubeconfigBinding>
>();

function isExpired(updatedAt: number) {
  return Date.now() - updatedAt > WS_TOKEN_EXPIRY_TIME;
}

export function setUserSealosKubeconfig(
  userId: number,
  area: string,
  kubeconfig: string,
) {
  let areaBindings = userSealosKubeconfigMap.get(userId);
  if (!areaBindings) {
    areaBindings = new Map<string, UserSealosKubeconfigBinding>();
    userSealosKubeconfigMap.set(userId, areaBindings);
  }

  areaBindings.set(area, {
    kubeconfig,
    updatedAt: Date.now(),
  });
}

export function getUserSealosKubeconfig(
  userId: number,
  area: string,
): string | null {
  const areaBindings = userSealosKubeconfigMap.get(userId);
  if (!areaBindings) return null;

  const current = areaBindings.get(area);
  if (!current) return null;

  if (isExpired(current.updatedAt)) {
    areaBindings.delete(area);
    if (areaBindings.size === 0) {
      userSealosKubeconfigMap.delete(userId);
    }
    return null;
  }

  return current.kubeconfig;
}

export function touchUserSealosKubeconfig(
  userId: number,
  area: string,
): boolean {
  const areaBindings = userSealosKubeconfigMap.get(userId);
  if (!areaBindings) return false;

  const current = areaBindings.get(area);
  if (!current) return false;

  if (isExpired(current.updatedAt)) {
    areaBindings.delete(area);
    if (areaBindings.size === 0) {
      userSealosKubeconfigMap.delete(userId);
    }
    return false;
  }

  current.updatedAt = Date.now();
  return true;
}
