import { useNavigate } from 'react-router-dom';
import { ProjectsPage } from './ProjectsPage';

export function ProjectsIndexRoute(): React.ReactElement {
  const navigate = useNavigate();
  return <ProjectsPage onOpenProject={id => navigate(`/cc-agent/projects/${encodeURIComponent(id)}`)} />;
}
