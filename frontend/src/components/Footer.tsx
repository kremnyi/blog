import { Box, Container, Typography } from '@mui/material'

const Footer = () => {
    return (
        <Box
            component="footer"
            sx={{
                py: 3,
                mt: 'auto',
                bgcolor: (theme) =>
                    theme.palette.mode === 'dark'
                        ? theme.palette.grey[900]
                        : theme.palette.grey[300],
                color: (theme) =>
                    theme.palette.mode === 'dark'
                        ? '#fff'
                        : theme.palette.text.primary,
            }}
        >
            <Container maxWidth="lg">
                <Typography variant="body1" align="center">
                    © {new Date().getFullYear()} My Blog - Built with React and
                    Material UI, served for $0 by Cloudflare Workers
                </Typography>
            </Container>
        </Box>
    )
}

export default Footer
