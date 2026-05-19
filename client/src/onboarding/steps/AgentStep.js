import { jsx as _jsx } from "react/jsx-runtime";
import { useTranslation } from 'react-i18next';
import { StepContainer } from '../components/StepContainer';
import { AgentIntegration } from '../../components/settings/AgentIntegration';
// 配置检测轮询已上移到 OnboardingProvider，步骤组件只读渲染即可
export function AgentStep() {
    const { t } = useTranslation('onboarding');
    return (_jsx(StepContainer, { title: t('agent.title'), description: t('agent.description'), skippable: true, children: _jsx(AgentIntegration, {}) }));
}
