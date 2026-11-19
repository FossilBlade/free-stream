import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, currentProfileId, setCurrentProfileId, type Profile } from './api';

interface ProfileState {
  /** null until loaded, or when nobody has picked a profile on this device yet. */
  profile: Profile | null;
  profiles: Profile[];
  hasPin: boolean;
  loaded: boolean;
  isKid: boolean;
  choose: (p: Profile) => void;
  reload: () => Promise<void>;
}

const Ctx = createContext<ProfileState>({ profile: null, profiles: [], hasPin: false, loaded: false, isKid: false, choose: () => {}, reload: async () => {} });

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.profiles();
      setProfiles(r.profiles);
      setHasPin(r.hasPin);
      const stored = currentProfileId();
      // A single profile needs no picking; otherwise remember this device's choice.
      const p = r.profiles.find((x) => x.id === stored) || (r.profiles.length === 1 ? r.profiles[0] : null);
      if (p) setCurrentProfileId(p.id);
      setProfile(p);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const choose = useCallback((p: Profile) => {
    setCurrentProfileId(p.id);
    setProfile(p);
  }, []);

  return <Ctx.Provider value={{ profile, profiles, hasPin, loaded, isKid: profile?.kind === 'kid', choose, reload }}>{children}</Ctx.Provider>;
}

export const useProfile = () => useContext(Ctx);
