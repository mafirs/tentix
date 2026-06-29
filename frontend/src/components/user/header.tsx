import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, InfoIcon, PanelLeft, CircleStopIcon } from "lucide-react";
import { Button } from "tentix-ui";
import { useTranslation } from "i18n";
import { type TicketType } from "tentix-server/rpc";
import { useCustomerFeedbackModal } from "@modal/use-customer-feedback-modal";

interface SiteHeaderProps {
  title: string;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  ticket?: TicketType;
  onOpenDetails?: () => void;
}

export function SiteHeader({
  title,
  sidebarVisible,
  toggleSidebar,
  ticket,
  onOpenDetails,
}: SiteHeaderProps) {
  const { t } = useTranslation();

  const { openCustomerFeedbackModal, customerFeedbackModal, isSubmitting } =
    useCustomerFeedbackModal();

  const isResolved = ticket?.status === "resolved";

  const handleCloseTicket = () => {
    if (ticket) {
      openCustomerFeedbackModal(ticket.id);
    }
  };

  return (
    <>
      <div className="flex h-14 w-full border-b items-center justify-between gap-2 px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 justify-center items-center rounded-md cursor-pointer flex md:hidden"
            aria-label={t("go_back")}
          >
            <Link to="/user/tickets/list">
              <ArrowLeftIcon className="h-5 w-5" />
            </Link>
          </Button>
          {toggleSidebar && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 justify-center items-center rounded-md cursor-pointer hidden xl:flex"
              onClick={toggleSidebar}
              aria-label={
                sidebarVisible ? t("hide_sidebar") : t("show_sidebar")
              }
            >
              <PanelLeft className="h-5 w-5" />
            </Button>
          )}
          <h1
            className="max-w-[calc(100vw-176px)] md:max-w-40 lg:max-w-60 xl:max-w-100 2xl:max-w-100 truncate block
                       text-[#000]
                       text-[16px]
                       font-[600]
                       leading-[100%]"
          >
            {title || t("work_orders")}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onOpenDetails && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex md:hidden"
              onClick={onOpenDetails}
              aria-label={t("info")}
            >
              <InfoIcon className="h-5 w-5" />
            </Button>
          )}
          {ticket && (
            <Button
              variant="default"
              className="bg-black hover:bg-black/90 px-3 py-2 h-9 sm:h-auto flex items-center"
              disabled={isResolved || isSubmitting}
              onClick={handleCloseTicket}
              aria-label={isSubmitting ? t("closing") : t("close_ticket")}
            >
              <CircleStopIcon className="h-4 w-4 text-white" />
              <span className="hidden sm:inline text-white text-sm font-medium leading-[20px]">
                {isSubmitting ? t("closing") : t("close_ticket")}
              </span>
            </Button>
          )}
        </div>
      </div>
      {customerFeedbackModal}
    </>
  );
}
