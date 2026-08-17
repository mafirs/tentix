import { create } from "zustand";
import { persist } from "zustand/middleware";

interface InternalMessagesState {
  showInternal: boolean;
  toggleShowInternal: () => void;
}

export const useInternalMessages = create<InternalMessagesState>()(
  persist(
    (set) => ({
      showInternal: false,
      toggleShowInternal: () =>
        set((state) => ({
          showInternal: !state.showInternal,
        })),
    }),
    {
      name: "internal-messages-visibility",
    },
  ),
);
