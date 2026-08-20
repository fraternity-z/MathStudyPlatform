import { apiClient } from '@/libs/http/apiClient';
import type {
  EmailActionResponse,
  EmailSettings,
  EmailSettingsOverride,
  EmailSettingsUpdate,
  EmailTemplate,
  EmailTemplateListResponse,
  EmailTemplatePreviewRequest,
  EmailTemplatePreviewResponse,
  EmailTemplateUpdate,
} from '@/modules/email/types/email';

const SETTINGS_PATH = '/admin/settings';

const templatePath = (event: string, locale: string): string =>
  `${SETTINGS_PATH}/email-templates/${encodeURIComponent(event)}/${encodeURIComponent(locale)}`;

export const adminEmailService = {
  async getSettings(signal?: AbortSignal): Promise<EmailSettings> {
    const response = await apiClient.get<EmailSettings>(`${SETTINGS_PATH}/email`, { signal });
    return response.data;
  },

  async updateSettings(settings: EmailSettingsUpdate): Promise<EmailSettings> {
    const response = await apiClient.put<EmailSettings>(`${SETTINGS_PATH}/email`, settings);
    return response.data;
  },

  async testSMTP(settings: EmailSettingsOverride): Promise<EmailActionResponse> {
    const response = await apiClient.post<EmailActionResponse>(`${SETTINGS_PATH}/test-smtp`, settings);
    return response.data;
  },

  async sendTestEmail(
    recipient: string,
    settings: EmailSettingsOverride,
  ): Promise<EmailActionResponse> {
    const response = await apiClient.post<EmailActionResponse>(
      `${SETTINGS_PATH}/send-test-email`,
      { recipient, ...settings },
    );
    return response.data;
  },

  async listTemplates(signal?: AbortSignal): Promise<EmailTemplateListResponse> {
    const response = await apiClient.get<EmailTemplateListResponse>(
      `${SETTINGS_PATH}/email-templates`,
      { signal },
    );
    return response.data;
  },

  async getTemplate(event: string, locale: string): Promise<EmailTemplate> {
    const response = await apiClient.get<EmailTemplate>(templatePath(event, locale));
    return response.data;
  },

  async updateTemplate(
    event: string,
    locale: string,
    template: EmailTemplateUpdate,
  ): Promise<EmailTemplate> {
    const response = await apiClient.put<EmailTemplate>(
      templatePath(event, locale),
      template,
    );
    return response.data;
  },

  async restoreTemplate(event: string, locale: string): Promise<EmailTemplate> {
    const response = await apiClient.post<EmailTemplate>(
      `${templatePath(event, locale)}/restore`,
    );
    return response.data;
  },

  async previewTemplate(
    request: EmailTemplatePreviewRequest,
  ): Promise<EmailTemplatePreviewResponse> {
    const response = await apiClient.post<EmailTemplatePreviewResponse>(
      `${SETTINGS_PATH}/email-template-preview`,
      request,
    );
    return response.data;
  },
};

export default adminEmailService;
